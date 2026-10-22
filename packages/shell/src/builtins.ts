// SPDX-License-Identifier: Apache-2.0
// Shell builtins: commands that read or change the shell's own state.

import { evaluateArith, ArithError } from './arith.ts';
import { echo, printf, printfFormat } from './commands/echo-printf.ts';
import { test } from './commands/test.ts';
import { resolvePath, strerror } from './commands/util.ts';
import { readLineShared } from './io.ts';
import type { Sink } from './io.ts';
import type { Io, Shell, ShellOptionFlags } from './shell.ts';
import { BreakSignal, ContinueSignal, ReturnSignal, ShellExit, runCommandFn } from './shell.ts';
import type { CommandFn } from './types.ts';

export type Builtin = (sh: Shell, argv: string[], io: Io, cond: boolean) => Promise<number>;

/** POSIX special builtins: assignments before them persist, errors are more severe. */
export const SPECIAL_BUILTINS = new Set([
  ':',
  '.',
  'break',
  'continue',
  'eval',
  'exec',
  'exit',
  'export',
  'readonly',
  'return',
  'set',
  'shift',
  'times',
  'trap',
  'unset',
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const write = (io: Io, s: string) => io.stdout.write(s);
const warn = (sh: Shell, io: Io, msg: string) => sh.report(io, msg);

/** Wraps a CommandFn (shared with the standalone command) as a builtin. */
const shared =
  (fn: CommandFn): Builtin =>
  (sh, argv, io) => {
    // As a builtin, its messages carry the shell's `name: line N:` prefix.
    const prefix = `${argv[0]}: `;
    const stderr: Sink = {
      write: (d) =>
        io.stderr.write(
          typeof d === 'string' && d.startsWith(prefix)
            ? `${sh.scriptName}: line ${sh.line}: ${d}`
            : d,
        ),
    };
    return runCommandFn(
      fn,
      sh.commandContext(argv, io.with(2, { w: stderr }), sh.exportedEnv(), sh.state.cwd),
    );
  };

function parseStatus(sh: Shell, arg: string | undefined, fallback: number): number | string {
  if (arg === undefined) return fallback;
  if (!/^[+-]?[0-9]+$/.test(arg)) return `${arg}: numeric argument required`;
  return Number(BigInt.asUintN(8, BigInt(arg)));
}

function loopCount(arg: string | undefined): number | string {
  if (arg === undefined) return 1;
  if (!/^[0-9]+$/.test(arg) || Number(arg) < 1) return `${arg}: loop count out of range`;
  return Number(arg);
}

/** `declare -p` style quoting: name="value" with ", \, $ and ` escaped. */
function declareQuote(v: string): string {
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
}

function setQuote(v: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(v) && v !== '') return v;
  if (v === '') return "''";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(v)) {
    return `$'${v
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r')}'`;
  }
  return `'${v.replace(/'/g, "'\\''")}'`;
}

const OPTION_LETTERS: Record<string, keyof ShellOptionFlags> = {
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  f: 'noglob',
  C: 'noclobber',
  a: 'allexport',
  v: 'verbose',
};
const SET_O_NAMES: (keyof ShellOptionFlags)[] = [
  'allexport',
  'errexit',
  'noclobber',
  'noglob',
  'nounset',
  'pipefail',
  'verbose',
  'xtrace',
];
const IGNORED_SET_O = new Set([
  'braceexpand',
  'hashall',
  'interactive-comments',
  'monitor',
  'notify',
  'posix',
  'emacs',
  'vi',
  'history',
  'ignoreeof',
  'nolog',
  'physical',
  'privileged',
  'keyword',
  'onecmd',
  'functrace',
  'errtrace',
  'histexpand',
]);

async function cd(sh: Shell, argv: string[], io: Io): Promise<number> {
  let args = argv.slice(1);
  let physical = false;
  while (args[0] === '-L' || args[0] === '-P' || args[0] === '--') {
    if (args[0] === '-P') physical = true;
    const done = args[0] === '--';
    args = args.slice(1);
    if (done) break;
  }
  if (args.length > 1) {
    await warn(sh, io, 'cd: too many arguments');
    return 1;
  }
  let target = args[0];
  let print = false;
  if (target === undefined) {
    target = sh.getVar('HOME');
    if (target === undefined) {
      await warn(sh, io, 'cd: HOME not set');
      return 1;
    }
  } else if (target === '-') {
    target = sh.getVar('OLDPWD');
    if (target === undefined) {
      await warn(sh, io, 'cd: OLDPWD not set');
      return 1;
    }
    print = true;
  }
  if (target === '') return 0;
  let dest = resolvePath(sh.state.cwd, target);
  try {
    const st = sh.fs.statSync(dest);
    if (!st.isDirectory()) {
      await warn(sh, io, `cd: ${target}: Not a directory`);
      return 1;
    }
    if (physical) dest = sh.fs.realpathSync(dest);
  } catch (err) {
    await warn(sh, io, `cd: ${target}: ${strerror(err)}`);
    return 1;
  }
  sh.setVar('OLDPWD', sh.state.cwd);
  sh.state.cwd = dest;
  sh.setVar('PWD', dest);
  if (print) await write(io, `${dest}\n`);
  return 0;
}

async function pwd(sh: Shell, argv: string[], io: Io): Promise<number> {
  let cwd = sh.state.cwd;
  if (argv.includes('-P')) {
    try {
      cwd = sh.fs.realpathSync(cwd);
    } catch {
      // keep the logical path
    }
  }
  await write(io, `${cwd}\n`);
  return 0;
}

async function exportBuiltin(sh: Shell, argv: string[], io: Io, readonly = false): Promise<number> {
  const args = argv.slice(1);
  let unexport = false;
  let print = false;
  while (args[0]?.startsWith('-') && args[0].length > 1) {
    const a = args.shift()!;
    if (a === '--') break;
    for (const f of a.slice(1)) {
      if (f === 'n') unexport = true;
      else if (f === 'p') print = true;
      else if (f === 'f') {
        // export -f: functions are always visible to subshells here.
      } else {
        await warn(sh, io, `${argv[0]}: -${f}: invalid option`);
        return 2;
      }
    }
  }
  if (args.length === 0 || print) {
    const names = [...sh.state.vars.keys()].sort();
    let out = '';
    for (const k of names) {
      const v = sh.state.vars.get(k)!;
      if (readonly ? !v.readonly : !v.exported) continue;
      const flag = readonly ? (v.exported ? '-rx' : '-r') : v.readonly ? '-rx' : '-x';
      out += `declare ${flag} ${k}=${declareQuote(v.value)}\n`;
    }
    await write(io, out);
    return 0;
  }
  let status = 0;
  for (const arg of args) {
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!NAME_RE.test(name)) {
      await warn(sh, io, `${argv[0]}: \`${arg}': not a valid identifier`);
      status = 1;
      continue;
    }
    if (eq >= 0) {
      const err = sh.setVar(name, arg.slice(eq + 1));
      if (err) {
        await warn(sh, io, err);
        status = 1;
        continue;
      }
    }
    const v = sh.state.vars.get(name);
    if (readonly) {
      if (v) v.readonly = true;
      else sh.state.vars.set(name, { value: '', exported: false, readonly: true });
    } else if (unexport) {
      if (v) v.exported = false;
      sh.state.pendingExport.delete(name);
    } else if (v) v.exported = true;
    // `export x` with x unset marks it for export but leaves it unset.
    else sh.state.pendingExport.add(name);
  }
  return status;
}

async function unset(sh: Shell, argv: string[], io: Io): Promise<number> {
  let args = argv.slice(1);
  let mode: 'v' | 'f' | 'both' = 'both';
  while (args[0] === '-v' || args[0] === '-f' || args[0] === '-n') {
    if (args[0] !== '-n') mode = args[0] === '-v' ? 'v' : 'f';
    args = args.slice(1);
  }
  let status = 0;
  for (const name of args) {
    if (mode !== 'f') {
      if (sh.state.vars.has(name)) {
        const err = sh.unsetVar(name);
        if (err) {
          await warn(sh, io, `unset: ${err}`);
          status = 1;
        }
        continue;
      }
      if (!NAME_RE.test(name) && mode === 'v') {
        await warn(sh, io, `unset: \`${name}': not a valid identifier`);
        status = 1;
        continue;
      }
    }
    if (mode !== 'v') sh.state.functions.delete(name);
  }
  return status;
}

async function set(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1);
  if (args.length === 0) {
    let out = '';
    for (const k of [...sh.state.vars.keys()].sort())
      out += `${k}=${setQuote(sh.state.vars.get(k)!.value)}\n`;
    await write(io, out);
    return 0;
  }
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      sh.state.positional = args.slice(i + 1);
      return 0;
    }
    if (a === '-') {
      sh.state.opts.xtrace = false;
      sh.state.opts.verbose = false;
      i++;
      break;
    }
    if (!/^[-+]/.test(a) || a.length < 2) break;
    const on = a[0] === '-';
    for (let j = 1; j < a.length; j++) {
      const f = a[j]!;
      if (f === 'o') {
        const name = args[++i];
        if (name === undefined) {
          await printOptions(sh, io, on);
          continue;
        }
        if (SET_O_NAMES.includes(name as keyof ShellOptionFlags)) {
          (sh.state.opts as unknown as Record<string, boolean>)[name] = on;
        } else if (!IGNORED_SET_O.has(name)) {
          await warn(sh, io, `set: ${name}: invalid option name`);
          return 1;
        }
        continue;
      }
      const opt = OPTION_LETTERS[f];
      if (opt) sh.state.opts[opt] = on;
      else if ('hbmBHPTknp'.includes(f)) {
        // accepted, no effect here
      } else {
        await warn(sh, io, `set: ${a[0]}${f}: invalid option`);
        return 2;
      }
    }
  }
  if (i < args.length) sh.state.positional = args.slice(i);
  return 0;
}

async function printOptions(sh: Shell, io: Io, human: boolean): Promise<void> {
  const all = [...SET_O_NAMES, 'braceexpand', 'hashall', 'interactive-comments'].sort();
  let out = '';
  for (const name of all) {
    const on =
      (sh.state.opts as unknown as Record<string, boolean>)[name] ??
      ['braceexpand', 'hashall', 'interactive-comments'].includes(name);
    out += human
      ? `${name.padEnd(15)}\t${on ? 'on' : 'off'}\n`
      : `set ${on ? '-' : '+'}o ${name}\n`;
  }
  await write(io, out);
}

async function shopt(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1);
  let mode: 's' | 'u' | 'q' | null = null;
  const names: string[] = [];
  for (const a of args) {
    if (a === '-s' || a === '-u' || a === '-q') mode = a[1] as 's' | 'u' | 'q';
    else if (a === '-o' || a === '-p') {
      // -o: set -o names; treated the same here.
    } else names.push(a);
  }
  const known = ['nullglob', 'dotglob', 'failglob', 'nocasematch'] as const;
  let status = 0;
  for (const name of names) {
    const k = (known as readonly string[]).includes(name) ? (name as (typeof known)[number]) : null;
    if (mode === 's' || mode === 'u') {
      if (k) sh.state.opts[k] = mode === 's';
      continue;
    }
    const on = k ? sh.state.opts[k] : false;
    if (mode !== 'q') await write(io, `${name.padEnd(15)}\t${on ? 'on' : 'off'}\n`);
    if (!on) status = 1;
  }
  return status;
}

async function read(sh: Shell, argv: string[], io: Io): Promise<number> {
  let raw = false;
  let delim = '\n';
  let count: number | null = null;
  let prompt = '';
  let fd = 0;
  const names: string[] = [];
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a === '-' || names.length > 0) {
      names.push(a);
      continue;
    }
    if (a === '--') {
      names.push(...args.slice(i + 1));
      break;
    }
    for (let j = 1; j < a.length; j++) {
      const f = a[j]!;
      const value = () => {
        const rest = a.slice(j + 1);
        j = a.length;
        return rest || args[++i] || '';
      };
      if (f === 'r') raw = true;
      else if (f === 's') {
        // no echo: nothing to suppress without a terminal
      } else if (f === 'd') {
        const v = value();
        delim = v === '' ? '\0' : v[0]!;
      } else if (f === 'n' || f === 'N') count = Number(value());
      else if (f === 'p') prompt = value();
      else if (f === 't') value();
      else if (f === 'u') fd = Number(value());
      else if (f === 'e') {
        // readline editing: not applicable
      } else if (f === 'a') {
        await warn(sh, io, 'read: -a: arrays are not supported');
        return 2;
      } else {
        await warn(sh, io, `read: -${f}: invalid option`);
        return 2;
      }
    }
  }
  if (names.length === 0) names.push('REPLY');
  for (const n of names) {
    if (!NAME_RE.test(n)) {
      await warn(sh, io, `read: \`${n}': not a valid identifier`);
      return 1;
    }
  }
  if (prompt) await io.stderr.write(prompt);
  const src = io.fds.get(fd)?.r;
  if (!src) {
    await warn(sh, io, `read: ${fd}: invalid file descriptor: Bad file descriptor`);
    return 1;
  }

  // Read up to the delimiter, honoring backslash-newline continuation unless -r.
  let text = '';
  let eof = false;
  const decoder = new TextDecoder();
  for (;;) {
    let chunk: Uint8Array | null;
    if (count !== null) {
      chunk = await readCount(src, count - [...text].length);
      if (chunk === null) {
        eof = true;
        break;
      }
      text += decoder.decode(chunk);
      if ([...text].length >= count) break;
      continue;
    }
    chunk = await readLineShared(src, delim.charCodeAt(0));
    if (chunk === null) {
      eof = true;
      break;
    }
    let line = decoder.decode(chunk);
    const terminated = line.endsWith(delim);
    if (terminated) line = line.slice(0, -1);
    else eof = true;
    if (!raw && line.endsWith('\\') && !line.endsWith('\\\\') && terminated && delim === '\n') {
      text += line.slice(0, -1);
      continue;
    }
    text += line;
    break;
  }
  if (eof && text === '') {
    for (const n of names) sh.setVar(n, '');
    return 1;
  }
  assignFields(sh, names, text, raw);
  return eof ? 1 : 0;
}

async function readCount(
  src: { read(): Promise<Uint8Array | null>; unshift(d: Uint8Array): void },
  n: number,
): Promise<Uint8Array | null> {
  const chunk = await src.read();
  if (chunk === null) return null;
  // Approximation: counts bytes, which equals characters for ASCII input.
  if (chunk.length > n) {
    src.unshift(chunk.subarray(n));
    return chunk.subarray(0, n);
  }
  return chunk;
}

/** Splits `text` on IFS into `names`; the last name gets the rest of the line. */
function assignFields(sh: Shell, names: string[], text: string, raw: boolean): void {
  const ifs = sh.ifs();
  const isWs = (c: string) => ifs.includes(c) && (c === ' ' || c === '\t' || c === '\n');
  const isDelim = (c: string) => ifs.includes(c);
  // Unescape backslashes (without -r) while tracking which chars were escaped.
  const chars: { c: string; escaped: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!raw && text[i] === '\\' && i + 1 < text.length) {
      chars.push({ c: text[++i]!, escaped: true });
    } else if (!raw && text[i] === '\\') {
      continue;
    } else chars.push({ c: text[i]!, escaped: false });
  }
  let i = 0;
  const skipWs = () => {
    while (i < chars.length && !chars[i]!.escaped && isWs(chars[i]!.c)) i++;
  };
  skipWs();
  for (let n = 0; n < names.length; n++) {
    const last = n === names.length - 1;
    if (last) {
      // Remainder with trailing IFS whitespace removed.
      let end = chars.length;
      while (end > i && !chars[end - 1]!.escaped && isWs(chars[end - 1]!.c)) end--;
      let value = chars
        .slice(i, end)
        .map((x) => x.c)
        .join('');
      // A single trailing non-whitespace delimiter is dropped when it is the only extra field.
      const rest = chars.slice(i, end);
      if (rest.length > 0) {
        const lastCh = rest[rest.length - 1]!;
        if (!lastCh.escaped && isDelim(lastCh.c) && !isWs(lastCh.c)) {
          const inner = rest.slice(0, -1);
          if (!inner.some((x) => !x.escaped && isDelim(x.c)))
            value = inner.map((x) => x.c).join('');
        }
      }
      sh.setVar(names[n]!, value);
      break;
    }
    let field = '';
    while (i < chars.length && (chars[i]!.escaped || !isDelim(chars[i]!.c))) field += chars[i++]!.c;
    sh.setVar(names[n]!, field);
    // Consume one delimiter: surrounding IFS whitespace plus at most one non-whitespace delimiter.
    skipWs();
    if (i < chars.length && !chars[i]!.escaped && isDelim(chars[i]!.c) && !isWs(chars[i]!.c)) {
      i++;
      skipWs();
    }
  }
}

async function evalBuiltin(sh: Shell, argv: string[], io: Io): Promise<number> {
  const src = argv.slice(1).join(' ');
  if (src.trim() === '') return 0;
  return sh.runString(src, io);
}

async function source(sh: Shell, argv: string[], io: Io): Promise<number> {
  const file = argv[1];
  if (file === undefined) {
    await warn(sh, io, `${argv[0]}: filename argument required`);
    return 2;
  }
  let path: string | undefined;
  if (file.includes('/')) path = resolvePath(sh.state.cwd, file);
  else {
    for (const dir of (sh.getVar('PATH') ?? '').split(':')) {
      const candidate = resolvePath(sh.state.cwd, dir || '.') + '/' + file;
      try {
        if (sh.fs.statSync(candidate).isFile()) {
          path = candidate;
          break;
        }
      } catch {
        // keep looking
      }
    }
    path ??= resolvePath(sh.state.cwd, file);
  }
  try {
    if (!sh.fs.statSync(path).isFile()) throw Object.assign(new Error(), { code: 'EISDIR' });
  } catch (err) {
    await warn(sh, io, `${file}: ${strerror(err)}`);
    return 1;
  }
  return sh.source(path, argv.length > 2 ? argv.slice(2) : null, io);
}

async function exec(sh: Shell, argv: string[], io: Io): Promise<number> {
  let args = argv.slice(1);
  while (args[0]?.startsWith('-')) {
    if (args[0] === '--') {
      args = args.slice(1);
      break;
    }
    // -a name, -c, -l: not meaningful here
    if (args[0] === '-a') args = args.slice(1);
    args = args.slice(1);
  }
  if (args.length === 0) return 0;
  const status = await sh.execProgram(args, io);
  throw new ShellExit(status);
}

async function commandBuiltin(sh: Shell, argv: string[], io: Io, cond: boolean): Promise<number> {
  const args = argv.slice(1);
  let mode: 'run' | 'v' | 'V' = 'run';
  while (args[0]?.startsWith('-') && args[0].length > 1) {
    const a = args.shift()!;
    if (a === '--') break;
    for (const f of a.slice(1)) {
      if (f === 'v') mode = 'v';
      else if (f === 'V') mode = 'V';
      else if (f !== 'p') {
        await warn(sh, io, `command: -${f}: invalid option`);
        return 2;
      }
    }
  }
  if (args.length === 0) return 0;
  if (mode !== 'run') {
    let status = 0;
    for (const name of args) {
      const d = describe(sh, name);
      if (!d) {
        if (mode === 'V') await warn(sh, io, `command: ${name}: not found`);
        status = 1;
        continue;
      }
      if (mode === 'v')
        await write(
          io,
          `${d.kind === 'file' ? d.path : d.kind === 'alias' ? `alias ${name}='${d.text}'` : name}\n`,
        );
      else await write(io, `${d.text}\n`);
    }
    return status;
  }
  const builtin = BUILTINS[args[0]!];
  if (builtin) return builtin(sh, args, io, cond);
  return sh.execProgram(args, io);
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  'select',
  'time',
]);

type Description =
  | { kind: 'alias'; text: string }
  | { kind: 'keyword'; text: string }
  | { kind: 'function'; text: string }
  | { kind: 'builtin'; text: string }
  | { kind: 'file'; path: string; text: string };

function describe(sh: Shell, name: string): Description | null {
  const alias = sh.state.aliases.get(name);
  if (alias !== undefined) return { kind: 'alias', text: alias };
  if (KEYWORDS.has(name)) return { kind: 'keyword', text: `${name} is a shell keyword` };
  if (sh.state.functions.has(name)) return { kind: 'function', text: `${name} is a function` };
  if (BUILTINS[name]) return { kind: 'builtin', text: `${name} is a shell builtin` };
  const r = sh.resolveCommand(name);
  if (r.kind === 'error') return null;
  return { kind: 'file', path: r.path, text: `${name} is ${r.path}` };
}

async function type(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1);
  let mode: 'text' | 't' | 'p' | 'P' = 'text';
  while (args[0]?.startsWith('-') && args[0].length > 1) {
    const a = args.shift()!;
    if (a === '--') break;
    for (const f of a.slice(1)) {
      if (f === 't') mode = 't';
      else if (f === 'p') mode = 'p';
      else if (f === 'P') mode = 'P';
      else if (f !== 'a' && f !== 'f') {
        await warn(sh, io, `type: -${f}: invalid option`);
        return 2;
      }
    }
  }
  let status = 0;
  for (const name of args) {
    const d = mode === 'P' ? fileOnly(sh, name) : describe(sh, name);
    if (!d) {
      if (mode === 'text') await warn(sh, io, `type: ${name}: not found`);
      status = 1;
      continue;
    }
    if (mode === 't') await write(io, `${d.kind}\n`);
    else if (mode === 'p' || mode === 'P') {
      if (d.kind === 'file') await write(io, `${d.path}\n`);
    } else if (d.kind === 'alias') await write(io, `${name} is aliased to \`${d.text}'\n`);
    else if (d.kind === 'function') await write(io, `${name} is a function\n`);
    else await write(io, `${d.text}\n`);
  }
  return status;
}

function fileOnly(sh: Shell, name: string): Description | null {
  const r = sh.resolveCommand(name);
  return r.kind === 'error' ? null : { kind: 'file', path: r.path, text: r.path };
}

async function local(sh: Shell, argv: string[], io: Io): Promise<number> {
  if (!sh.inFunction) {
    await warn(sh, io, 'local: can only be used in a function');
    return 1;
  }
  return declare(sh, argv, io, true);
}

async function declare(
  sh: Shell,
  argv: string[],
  io: Io,
  isLocal = sh.inFunction,
): Promise<number> {
  const args = argv.slice(1);
  const flags = new Set<string>();
  const off = new Set<string>();
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (!/^[-+][a-zA-Z]+$/.test(a)) break;
    for (const f of a.slice(1)) (a[0] === '-' ? flags : off).add(f);
  }
  if (flags.has('a') || flags.has('A')) {
    await warn(sh, io, `${argv[0]}: arrays are not supported`);
    return 2;
  }
  const names = args.slice(i);
  if (flags.has('g')) isLocal = false;
  if (names.length === 0) {
    if (flags.has('f') || flags.has('F')) {
      for (const n of [...sh.state.functions.keys()].sort()) await write(io, `declare -f ${n}\n`);
      return 0;
    }
    let out = '';
    for (const k of [...sh.state.vars.keys()].sort()) {
      const v = sh.state.vars.get(k)!;
      if (flags.has('x') && !v.exported) continue;
      if (flags.has('r') && !v.readonly) continue;
      out += `declare ${attrs(v)} ${k}=${declareQuote(v.value)}\n`;
    }
    await write(io, out);
    return 0;
  }
  let status = 0;
  for (const arg of names) {
    const eq = arg.indexOf('=');
    const plus = eq > 0 && arg[eq - 1] === '+';
    const name = eq < 0 ? arg : arg.slice(0, plus ? eq - 1 : eq);
    if (flags.has('p')) {
      const v = sh.state.vars.get(name);
      if (!v) {
        await warn(sh, io, `declare: ${name}: not found`);
        status = 1;
      } else await write(io, `declare ${attrs(v)} ${name}=${declareQuote(v.value)}\n`);
      continue;
    }
    if (flags.has('f')) {
      if (!sh.state.functions.has(name)) status = 1;
      continue;
    }
    if (!NAME_RE.test(name)) {
      await warn(sh, io, `${argv[0]}: \`${arg}': not a valid identifier`);
      status = 1;
      continue;
    }
    if (isLocal) {
      sh.declareLocal(name);
      // A new local without a value starts out unset.
      if (eq < 0 && flags.size === 0) sh.state.vars.delete(name);
    }
    let v = sh.state.vars.get(name);
    if (!v && (eq >= 0 || isLocal || flags.size > 0)) {
      // `local x` creates x as set-but-empty only when given a value; bash leaves it unset.
      if (eq >= 0 || flags.has('x') || flags.has('r') || flags.has('i')) {
        v = { value: '', exported: false, readonly: false };
        sh.state.vars.set(name, v);
      } else if (isLocal) {
        sh.state.vars.delete(name);
      }
    }
    if (v) {
      if (flags.has('i')) v.integer = true;
      if (off.has('i')) delete v.integer;
      if (flags.has('x')) v.exported = true;
      if (off.has('x')) v.exported = false;
    }
    if (eq >= 0) {
      let value = arg.slice(eq + 1);
      if (flags.has('l')) value = value.toLowerCase();
      if (flags.has('u')) value = value.toUpperCase();
      try {
        const err = plus
          ? sh.setVar(name, (sh.state.vars.get(name)?.value ?? '') + value)
          : sh.setVar(name, value);
        if (err) {
          await warn(sh, io, err);
          status = 1;
          continue;
        }
      } catch (err) {
        if (err instanceof ArithError) {
          await warn(sh, io, err.message);
          status = 1;
          continue;
        }
        throw err;
      }
    }
    if (flags.has('r')) {
      const cur = sh.state.vars.get(name);
      if (cur) cur.readonly = true;
      else sh.state.vars.set(name, { value: '', exported: false, readonly: true });
    }
  }
  return status;
}

function attrs(v: { exported: boolean; readonly: boolean; integer?: boolean }): string {
  let s = '';
  if (v.integer) s += 'i';
  if (v.readonly) s += 'r';
  if (v.exported) s += 'x';
  return s ? `-${s}` : '--';
}

async function shift(sh: Shell, argv: string[], io: Io): Promise<number> {
  const n = argv[1] === undefined ? 1 : Number(argv[1]);
  if (!Number.isInteger(n) || n < 0) {
    await warn(sh, io, `shift: ${argv[1]}: numeric argument required`);
    return 1;
  }
  if (n > sh.state.positional.length) return 1;
  sh.state.positional = sh.state.positional.slice(n);
  return 0;
}

async function exit(sh: Shell, argv: string[], io: Io): Promise<number> {
  const s = parseStatus(sh, argv[1], sh.state.status);
  if (typeof s === 'string') {
    await warn(sh, io, `exit: ${s}`);
    throw new ShellExit(2);
  }
  throw new ShellExit(s);
}

async function returnBuiltin(sh: Shell, argv: string[], io: Io): Promise<number> {
  if (!sh.inFunction && !sh.inSource) {
    await warn(sh, io, "return: can only `return' from a function or sourced script");
    return 1;
  }
  const s = parseStatus(sh, argv[1], sh.state.status);
  if (typeof s === 'string') {
    await warn(sh, io, `return: ${s}`);
    throw new ReturnSignal(2);
  }
  throw new ReturnSignal(s);
}

const loopControl =
  (kind: 'break' | 'continue'): Builtin =>
  async (sh, argv, io) => {
    const n = loopCount(argv[1]);
    if (typeof n === 'string') {
      await warn(sh, io, `${kind}: ${n}`);
      return 1;
    }
    if (!sh.inLoop) {
      await warn(sh, io, `${kind}: only meaningful in a \`for', \`while', or \`until' loop`);
      return 0;
    }
    throw kind === 'break' ? new BreakSignal(n) : new ContinueSignal(n);
  };

async function trap(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1).filter((a) => a !== '--');
  if (args.length === 0 || args[0] === '-p') {
    let out = '';
    for (const [sig, action] of sh.state.traps) out += `trap -- ${setQuote(action)} ${sig}\n`;
    await write(io, out);
    return 0;
  }
  if (args[0] === '-l') {
    await write(io, ' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t13) SIGPIPE\t15) SIGTERM\n');
    return 0;
  }
  let action: string | null = args[0]!;
  let sigs = args.slice(1);
  if (/^[0-9]+$/.test(action) && sigs.length === 0) {
    sigs = [action];
    action = null;
  }
  if (action === '-') action = null;
  for (let sig of sigs) {
    sig = sig.toUpperCase().replace(/^SIG/, '');
    if (sig === '0') sig = 'EXIT';
    if (action === null) sh.state.traps.delete(sig);
    else sh.state.traps.set(sig, action);
  }
  return 0;
}

async function wait(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1);
  if (args[0] === '-n') return (await sh.waitAny()) ?? 127;
  if (args.length === 0) {
    await sh.waitAll();
    return 0;
  }
  let status = 0;
  for (const a of args) {
    const pid = Number(a.replace(/^%/, ''));
    const r = await sh.waitFor(pid);
    if (r === null) {
      await warn(sh, io, `wait: pid ${a} is not a child of this shell`);
      status = 127;
    } else status = r;
  }
  return status;
}

async function jobs(sh: Shell, _argv: string[], io: Io): Promise<number> {
  let out = '';
  for (const j of sh.jobList())
    out += `[${j.id}]  ${j.status === null ? 'Running' : 'Done'}\t\t${j.pid}\n`;
  await write(io, out);
  return 0;
}

async function let_(sh: Shell, argv: string[], io: Io): Promise<number> {
  if (argv.length < 2) {
    await warn(sh, io, 'let: expression expected');
    return 1;
  }
  let v = 0n;
  try {
    for (const e of argv.slice(1)) v = evaluateArith(e, sh.arithScope());
  } catch (err) {
    if (err instanceof ArithError) {
      await warn(sh, io, `let: ${err.message}`);
      return 1;
    }
    throw err;
  }
  return v === 0n ? 1 : 0;
}

async function getopts(sh: Shell, argv: string[], io: Io): Promise<number> {
  const spec = argv[1];
  const name = argv[2];
  if (spec === undefined || name === undefined) {
    await warn(sh, io, 'getopts: usage: getopts optstring name [arg ...]');
    return 2;
  }
  const args = argv.length > 3 ? argv.slice(3) : sh.state.positional;
  const silent = spec.startsWith(':');
  const opts = silent ? spec.slice(1) : spec;
  const st = sh.state.getopts;
  const idx = Number(sh.getVar('OPTIND') ?? '1') || 1;
  if (idx !== st.index) {
    st.index = idx;
    st.sub = 0;
  }
  const finish = () => {
    sh.setVar(name, '?');
    sh.unsetVar('OPTARG');
    return 1;
  };
  const arg = args[st.index - 1];
  if (st.sub === 0) {
    if (arg === undefined || !arg.startsWith('-') || arg === '-') return finish();
    if (arg === '--') {
      st.index++;
      sh.setVar('OPTIND', String(st.index));
      st.index = Number(sh.getVar('OPTIND'));
      return finish();
    }
    st.sub = 1;
  }
  const cur = args[st.index - 1]!;
  const c = cur[st.sub]!;
  st.sub++;
  const advance = () => {
    if (st.sub >= cur.length) {
      st.index++;
      st.sub = 0;
    }
  };
  const k = opts.indexOf(c);
  if (k < 0 || c === ':') {
    advance();
    if (silent) {
      sh.setVar('OPTARG', c);
    } else {
      await io.stderr.write(`${sh.scriptName}: illegal option -- ${c}\n`);
      sh.unsetVar('OPTARG');
    }
    sh.setVar(name, '?');
    syncOptind(sh, st);
    return 0;
  }
  if (opts[k + 1] === ':') {
    let value: string | undefined;
    if (st.sub < cur.length) {
      value = cur.slice(st.sub);
      st.index++;
      st.sub = 0;
    } else {
      value = args[st.index];
      st.index += 2;
      st.sub = 0;
    }
    if (value === undefined) {
      if (silent) {
        sh.setVar(name, ':');
        sh.setVar('OPTARG', c);
      } else {
        await io.stderr.write(`${sh.scriptName}: option requires an argument -- ${c}\n`);
        sh.setVar(name, '?');
        sh.unsetVar('OPTARG');
      }
      syncOptind(sh, st);
      return 0;
    }
    sh.setVar('OPTARG', value);
  } else {
    advance();
    sh.unsetVar('OPTARG');
  }
  sh.setVar(name, c);
  syncOptind(sh, st);
  return 0;
}

function syncOptind(sh: Shell, st: { index: number; sub: number }): void {
  const sub = st.sub;
  sh.setVar('OPTIND', String(st.index));
  st.sub = sub;
}

async function alias(sh: Shell, argv: string[], io: Io): Promise<number> {
  const args = argv.slice(1).filter((a) => a !== '-p');
  if (args.length === 0) {
    let out = '';
    for (const [k, v] of [...sh.state.aliases].sort())
      out += `alias ${k}='${v.replace(/'/g, "'\\''")}'\n`;
    await write(io, out);
    return 0;
  }
  let status = 0;
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq < 0) {
      const v = sh.state.aliases.get(a);
      if (v === undefined) {
        await warn(sh, io, `alias: ${a}: not found`);
        status = 1;
      } else await write(io, `alias ${a}='${v}'\n`);
    } else sh.state.aliases.set(a.slice(0, eq), a.slice(eq + 1));
  }
  return status;
}

async function unalias(sh: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[1] === '-a') {
    sh.state.aliases.clear();
    return 0;
  }
  let status = 0;
  for (const a of argv.slice(1)) {
    if (!sh.state.aliases.delete(a)) {
      await warn(sh, io, `unalias: ${a}: not found`);
      status = 1;
    }
  }
  return status;
}

async function printfBuiltin(sh: Shell, argv: string[], io: Io): Promise<number> {
  if (argv[1] === '-v') {
    const name = argv[2];
    if (name === undefined || argv[3] === undefined) {
      await warn(sh, io, 'printf: usage: printf [-v var] format [arguments]');
      return 2;
    }
    const r = printfFormat(argv[3], argv.slice(4));
    for (const e of r.errors) await warn(sh, io, `printf: ${e}`);
    const err = sh.setVar(name, r.out);
    if (err) {
      await warn(sh, io, err);
      return 1;
    }
    return r.status;
  }
  return shared(printf)(sh, argv, io, false);
}

async function pushd(sh: Shell, argv: string[], io: Io): Promise<number> {
  const dir = argv[1];
  const from = sh.state.cwd;
  if (dir === undefined) {
    const top = sh.state.dirStack.shift();
    if (top === undefined) {
      await warn(sh, io, 'pushd: no other directory');
      return 1;
    }
    const s = await cd(sh, ['cd', top], io);
    if (s === 0) sh.state.dirStack.unshift(from);
    return s === 0 ? dirs(sh, ['dirs'], io) : s;
  }
  const s = await cd(sh, ['cd', dir], io);
  if (s !== 0) return s;
  sh.state.dirStack.unshift(from);
  return dirs(sh, ['dirs'], io);
}

async function popd(sh: Shell, _argv: string[], io: Io): Promise<number> {
  const top = sh.state.dirStack.shift();
  if (top === undefined) {
    await warn(sh, io, 'popd: directory stack empty');
    return 1;
  }
  const s = await cd(sh, ['cd', top], io);
  return s === 0 ? dirs(sh, ['dirs'], io) : s;
}

async function dirs(sh: Shell, _argv: string[], io: Io): Promise<number> {
  const home = sh.getVar('HOME');
  const show = (d: string) =>
    home && (d === home || d.startsWith(`${home}/`)) ? `~${d.slice(home.length)}` : d;
  await write(io, `${[sh.state.cwd, ...sh.state.dirStack].map(show).join(' ')}\n`);
  return 0;
}

export const BUILTINS: Record<string, Builtin> = {
  ':': async () => 0,
  true: async () => 0,
  false: async () => 1,
  echo: shared(echo),
  printf: printfBuiltin,
  test: shared(test),
  '[': shared(test),
  cd,
  pwd,
  export: (sh, argv, io) => exportBuiltin(sh, argv, io),
  readonly: (sh, argv, io) => exportBuiltin(sh, argv, io, true),
  unset,
  set,
  shopt,
  shift,
  exit,
  return: returnBuiltin,
  break: loopControl('break'),
  continue: loopControl('continue'),
  local,
  declare: (sh, argv, io) => declare(sh, argv, io),
  typeset: (sh, argv, io) => declare(sh, argv, io),
  read,
  eval: evalBuiltin,
  source,
  '.': source,
  exec,
  command: commandBuiltin,
  type,
  hash: async () => 0,
  wait,
  jobs,
  trap,
  umask: async (_sh, argv, io) => {
    if (argv.length === 1) await write(io, '0022\n');
    return 0;
  },
  let: let_,
  getopts,
  alias,
  unalias,
  pushd,
  popd,
  dirs,
  times: async (_sh, _argv, io) => {
    await write(io, '0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n');
    return 0;
  },
  builtin: async (sh, argv, io, cond) => {
    const b = BUILTINS[argv[1] ?? ''];
    if (!b) {
      await warn(sh, io, `builtin: ${argv[1] ?? ''}: not a shell builtin`);
      return 1;
    }
    return b(sh, argv.slice(1), io, cond);
  },
};
