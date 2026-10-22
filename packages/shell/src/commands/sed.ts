// SPDX-License-Identifier: Apache-2.0
// `sed` (GNU sed subset): addresses (N, $, /re/, first~step, ranges, addr,+N,
// 0,/re/, !), commands s y d D p P n N g G h H x a i c = q Q l r w b t T : { }
// z F, options -n -e -f -E/-r -i[SUF] -s -z.

import { decode, readAll } from '../io.ts';
import type { CommandContext } from '../types.ts';
import { RegexSyntaxError, posixToJs } from './regex.ts';
import { complain, fileSource, quoteName, resolvePath, strerror } from './util.ts';

type Address =
  | { k: 'line'; n: number }
  | { k: 'last' }
  | { k: 're'; re: RegExp | null }
  | { k: 'step'; first: number; step: number }
  | { k: 'zero' };

interface Cmd {
  a1: Address | null;
  a2: Address | { k: 'plus'; n: number } | { k: 'mult'; n: number } | null;
  negate: boolean;
  name: string;
  text?: string;
  label?: string;
  re?: RegExp | null;
  replacement?: string;
  global?: boolean;
  nth?: number;
  print?: number;
  wfile?: string;
  exitCode?: number;
  ysrc?: string[];
  ydst?: string[];
  /** Index of the matching `}` for `{`. */
  block?: number;
  /** Range state. */
  active?: boolean;
  endLine?: number;
}

class SedError extends Error {}

class ScriptParser {
  private readonly src: string;
  private pos = 0;
  private readonly extended: boolean;
  readonly cmds: Cmd[] = [];

  constructor(src: string, extended: boolean) {
    this.src = src;
    this.extended = extended;
  }

  parse(): Cmd[] {
    const blocks: number[] = [];
    for (;;) {
      this.skip(' \t\n;');
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      const cmd: Cmd = { a1: null, a2: null, negate: false, name: '' };
      cmd.a1 = this.address();
      if (cmd.a1 && this.src[this.pos] === ',') {
        this.pos++;
        this.skip(' \t');
        if (this.src[this.pos] === '+' || this.src[this.pos] === '~') {
          const kind = this.src[this.pos] === '+' ? 'plus' : 'mult';
          this.pos++;
          cmd.a2 = { k: kind, n: this.number() };
        } else {
          const a2 = this.address();
          if (!a2) throw new SedError("unexpected `,'");
          cmd.a2 = a2;
        }
      }
      if (cmd.a1?.k === 'zero' && !(cmd.a2 && cmd.a2.k === 're'))
        throw new SedError('invalid usage of line address 0');
      this.skip(' \t');
      while (this.src[this.pos] === '!') {
        cmd.negate = !cmd.negate;
        this.pos++;
        this.skip(' \t');
      }
      const name = this.src[this.pos++];
      if (name === undefined) throw new SedError('missing command');
      cmd.name = name;
      switch (name) {
        case '{':
          blocks.push(this.cmds.length);
          break;
        case '}':
          if (blocks.length === 0) throw new SedError("unexpected `}'");
          if (cmd.a1) throw new SedError("} doesn't want any addresses");
          this.cmds[blocks.pop()!]!.block = this.cmds.length;
          break;
        case 'a':
        case 'i':
        case 'c':
          cmd.text = this.text();
          break;
        case ':':
          if (cmd.a1) throw new SedError(": doesn't want any addresses");
          cmd.label = this.label();
          if (!cmd.label) throw new SedError('":" lacks a label');
          break;
        case 'b':
        case 't':
        case 'T':
          cmd.label = this.label();
          break;
        case 'r':
        case 'R':
        case 'w':
        case 'W':
          cmd.wfile = this.filename();
          break;
        case 'q':
        case 'Q':
        case 'l':
        case 'L': {
          this.skip(' \t');
          const m = /^\d+/.exec(this.src.slice(this.pos));
          if (m) {
            cmd.exitCode = Number(m[0]);
            this.pos += m[0].length;
          }
          break;
        }
        case 's':
          this.substitute(cmd);
          break;
        case 'y':
          this.transliterate(cmd);
          break;
        case '=':
        case 'd':
        case 'D':
        case 'g':
        case 'G':
        case 'h':
        case 'H':
        case 'n':
        case 'N':
        case 'p':
        case 'P':
        case 'x':
        case 'z':
        case 'F':
        case 'e':
          break;
        default:
          throw new SedError(`unknown command: \`${name}'`);
      }
      this.cmds.push(cmd);
      this.skip(' \t');
      const c = this.src[this.pos];
      if (
        c !== undefined &&
        c !== ';' &&
        c !== '\n' &&
        c !== '}' &&
        c !== '#' &&
        name !== '{' &&
        name !== '}'
      ) {
        throw new SedError(`extra characters after command`);
      }
    }
    if (blocks.length > 0) throw new SedError("unmatched `{'");
    return this.cmds;
  }

  private skip(chars: string): void {
    while (this.pos < this.src.length && chars.includes(this.src[this.pos]!)) this.pos++;
  }

  private number(): number {
    const m = /^\d+/.exec(this.src.slice(this.pos));
    if (!m) throw new SedError('expected number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  private address(): Address | null {
    const c = this.src[this.pos];
    if (c === undefined) return null;
    if (/\d/.test(c)) {
      const n = this.number();
      if (this.src[this.pos] === '~') {
        this.pos++;
        return { k: 'step', first: n, step: this.number() };
      }
      return n === 0 ? { k: 'zero' } : { k: 'line', n };
    }
    if (c === '$') {
      this.pos++;
      return { k: 'last' };
    }
    if (c === '/' || c === '\\') {
      let delim = '/';
      if (c === '\\') {
        delim = this.src[this.pos + 1]!;
        this.pos += 2;
      } else this.pos++;
      const body = this.until(delim, true);
      let flags = '';
      while (this.src[this.pos] === 'I' || this.src[this.pos] === 'M') {
        flags += this.src[this.pos] === 'I' ? 'i' : 'm';
        this.pos++;
      }
      return { k: 're', re: this.compile(body, flags) };
    }
    return null;
  }

  /** Reads up to an unescaped `delim`; a `\delim` becomes the delimiter itself. */
  private until(delim: string, regex: boolean): string {
    let out = '';
    let inBracket = false;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined)
        throw new SedError(`unterminated ${regex ? 'address regex' : "`s' command"}`);
      this.pos++;
      if (regex && c === '[' && !inBracket) {
        inBracket = true;
        out += c;
        if (this.src[this.pos] === '^') out += this.src[this.pos++];
        if (this.src[this.pos] === ']') out += this.src[this.pos++];
        continue;
      }
      if (inBracket) {
        if (c === ']') inBracket = false;
        out += c;
        continue;
      }
      if (c === '\\') {
        const n = this.src[this.pos++];
        if (n === undefined) throw new SedError("unterminated `s' command");
        if (n === delim && delim !== '&')
          out += regex && '.*[]^$+?(){}|'.includes(n) ? `\\${n}` : n;
        else if (n === 'n') out += regex ? '\\n' : '\n';
        else out += `\\${n}`;
        continue;
      }
      if (c === delim) return out;
      if (c === '\n' && !regex) {
        out += c;
        continue;
      }
      out += c;
    }
  }

  private compile(body: string, flags: string): RegExp | null {
    if (body === '') return null;
    try {
      return new RegExp(posixToJs(body, this.extended), flags);
    } catch (err) {
      if (err instanceof RegexSyntaxError) throw new SedError(err.message);
      throw new SedError(err instanceof Error ? err.message : String(err));
    }
  }

  private substitute(cmd: Cmd): void {
    const delim = this.src[this.pos++];
    if (delim === undefined || delim === '\n' || delim === '\\')
      throw new SedError("unterminated `s' command");
    const pattern = this.until(delim, true);
    const replacement = this.until(delim, false);
    let flags = '';
    let nth = 0;
    let print = 0;
    for (;;) {
      const c = this.src[this.pos];
      if (c === 'g') cmd.global = true;
      else if (c === 'p') print++;
      else if (c === 'i' || c === 'I') flags += 'i';
      else if (c === 'm' || c === 'M') flags += 'm';
      else if (c === 'e') {
        // execute: unsupported, ignored
      } else if (c !== undefined && /\d/.test(c)) {
        nth = this.number();
        continue;
      } else if (c === 'w') {
        this.pos++;
        cmd.wfile = this.filename();
        break;
      } else break;
      this.pos++;
    }
    cmd.re = this.compile(pattern, flags);
    cmd.replacement = replacement;
    cmd.nth = nth || 1;
    cmd.print = print;
  }

  private transliterate(cmd: Cmd): void {
    const delim = this.src[this.pos++]!;
    const unescape = (s: string) =>
      s.replace(/\\(.)/gs, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    const a = [...unescape(this.until(delim, false))];
    const b = [...unescape(this.until(delim, false))];
    if (a.length !== b.length) throw new SedError("strings for `y' command are different lengths");
    cmd.ysrc = a;
    cmd.ydst = b;
  }

  private label(): string {
    this.skip(' \t');
    const m = /^[^;\n}]*/.exec(this.src.slice(this.pos))!;
    this.pos += m[0].length;
    return m[0].trim();
  }

  private filename(): string {
    this.skip(' \t');
    const m = /^[^\n]*/.exec(this.src.slice(this.pos))!;
    this.pos += m[0].length;
    return m[0];
  }

  /** Text for a/i/c: GNU one-liner (`a foo`) or classic (`a\` newline text). */
  private text(): string {
    this.skip(' \t');
    if (this.src[this.pos] === '\\') {
      this.pos++;
      if (this.src[this.pos] === '\n') this.pos++;
    }
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === '\\') {
        const n = this.src[this.pos + 1];
        if (n === '\n') {
          out += '\n';
          this.pos += 2;
          continue;
        }
        if (n !== undefined) {
          out += n === 't' ? '\t' : n;
          this.pos += 2;
          continue;
        }
      }
      if (c === '\n') break;
      out += c;
      this.pos++;
    }
    return out;
  }
}

interface InputLine {
  text: string;
  newline: boolean;
}

/** Expands a replacement: & \1..\9 \n \L \U \l \u \E. */
function expandReplacement(rep: string, m: RegExpExecArray): string {
  let out = '';
  let caseMode: 'U' | 'L' | null = null;
  let oneShot: 'u' | 'l' | null = null;
  const add = (s: string) => {
    for (const ch of s) {
      let c = ch;
      if (oneShot) {
        c = oneShot === 'u' ? c.toUpperCase() : c.toLowerCase();
        oneShot = null;
      } else if (caseMode) c = caseMode === 'U' ? c.toUpperCase() : c.toLowerCase();
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i]!;
    if (c === '&') {
      add(m[0]);
      continue;
    }
    if (c === '\\' && i + 1 < rep.length) {
      const n = rep[++i]!;
      if (/\d/.test(n)) add(m[Number(n)] ?? '');
      else if (n === 'n') add('\n');
      else if (n === 't') add('\t');
      else if (n === 'U' || n === 'L') caseMode = n;
      else if (n === 'E') caseMode = null;
      else if (n === 'u' || n === 'l') oneShot = n;
      else if (n === '&') add('&');
      else add(n);
      continue;
    }
    add(c);
  }
  return out;
}

function escapeL(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\x07') out += '\\a';
    else if (ch === '\v') out += '\\v';
    else if (code < 32 || code === 127) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  // Wrap at 69 characters plus a trailing backslash, like GNU `l`.
  const lines: string[] = [];
  let rest = out;
  while (rest.length > 69) {
    lines.push(`${rest.slice(0, 69)}\\`);
    rest = rest.slice(69);
  }
  lines.push(`${rest}$`);
  return lines.join('\n');
}

export async function sed(ctx: CommandContext): Promise<number> {
  const args = ctx.argv.slice(1);
  const scripts: string[] = [];
  const files: string[] = [];
  let quiet = false;
  let extended = false;
  let inPlace: string | null = null;
  let separate = false;
  let nulData = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    if (a === '-n' || a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-E' || a === '-r' || a === '--regexp-extended') extended = true;
    else if (a === '-s' || a === '--separate') separate = true;
    else if (a === '-z' || a === '--null-data') nulData = true;
    else if (
      a === '-u' ||
      a === '--unbuffered' ||
      a === '--posix' ||
      a === '--debug' ||
      a === '--sandbox'
    ) {
      // no effect
    } else if (a === '-e' || a === '--expression') {
      const v = args[++i];
      if (v === undefined) {
        await complain(ctx, "option requires an argument -- 'e'");
        return 1;
      }
      scripts.push(v);
    } else if (a.startsWith('--expression=')) scripts.push(a.slice(13));
    else if (a === '-f' || a === '--file' || a.startsWith('--file=')) {
      const v = a.startsWith('--file=') ? a.slice(7) : args[++i];
      try {
        scripts.push(decode(ctx.fs.readFileSync(resolvePath(ctx.cwd, v ?? ''))).replace(/\n$/, ''));
      } catch (err) {
        await complain(ctx, `couldn't open file ${v}: ${strerror(err)}`);
        return 1;
      }
    } else if (a.startsWith('-i') || a.startsWith('--in-place')) {
      inPlace = a.startsWith('-i')
        ? a.slice(2)
        : a.includes('=')
          ? a.slice(a.indexOf('=') + 1)
          : '';
      separate = true;
    } else if (a.startsWith('-e') && a.length > 2) scripts.push(a.slice(2));
    else if (/^-[nErsz]+$/.test(a)) {
      for (const f of a.slice(1)) {
        if (f === 'n') quiet = true;
        else if (f === 'E' || f === 'r') extended = true;
        else if (f === 's') separate = true;
        else if (f === 'z') nulData = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      await complain(ctx, `invalid option -- '${a.slice(1)}'`);
      return 1;
    } else files.push(a);
  }
  if (scripts.length === 0) {
    if (files.length === 0) {
      await ctx.stderr.write(
        'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n',
      );
      return 1;
    }
    scripts.push(files.shift()!);
  }
  let cmds: Cmd[];
  try {
    cmds = new ScriptParser(scripts.join('\n'), extended).parse();
  } catch (err) {
    if (err instanceof SedError) {
      await complain(ctx, `-e expression #1, char 0: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const labels = new Map<string, number>();
  cmds.forEach((c, i) => {
    if (c.name === ':') labels.set(c.label!, i);
  });
  for (const c of cmds) {
    if ((c.name === 'b' || c.name === 't' || c.name === 'T') && c.label && !labels.has(c.label)) {
      await complain(ctx, `-e expression #1, char 0: can't find label for jump to \`${c.label}'`);
      return 1;
    }
  }
  const delim = nulData ? '\0' : '\n';

  // Inputs: read whole files, split into lines.
  type Unit = { name: string; lines: InputLine[] };
  const units: Unit[] = [];
  let status = 0;
  const readUnit = async (name: string): Promise<Unit | null> => {
    try {
      let data: Uint8Array;
      if (name === '-') data = await readAll(ctx.stdin);
      else {
        const path = resolvePath(ctx.cwd, name);
        if (ctx.fs.statSync(path).isDirectory()) {
          await complain(ctx, `couldn't edit ${name}: not a regular file`);
          status = inPlace !== null ? 4 : 2;
          return null;
        }
        const src = fileSource(ctx.fs, path);
        data = await readAll(src);
        src.close();
      }
      const text = decode(data);
      const parts = text.split(delim);
      const lines: InputLine[] = parts.map((t, i) => ({ text: t, newline: i < parts.length - 1 }));
      if (
        lines.length > 0 &&
        lines[lines.length - 1]!.text === '' &&
        !lines[lines.length - 1]!.newline
      )
        lines.pop();
      return { name, lines };
    } catch (err) {
      await complain(ctx, `can't read ${name}: ${strerror(err)}`);
      status = 2;
      return null;
    }
  };
  for (const name of files.length > 0 ? files : ['-']) {
    const u = await readUnit(name);
    if (u) units.push(u);
  }

  const groups: Unit[][] = separate ? units.map((u) => [u]) : [units];
  const wfiles = new Map<string, string[]>();
  let lastRe: RegExp | null = null;
  let hold = '';
  let quitCode: number | null = null;

  for (const group of groups) {
    if (quitCode !== null) break;
    const lines: (InputLine & { unit: number })[] = [];
    group.forEach((u, ui) => lines.push(...u.lines.map((l) => ({ ...l, unit: ui }))));
    let out = '';
    let idx = 0;
    let lineNo = 0;
    for (const c of cmds) {
      c.active = false;
      delete c.endLine;
    }
    const isLast = () => idx >= lines.length;
    const write = (s: string) => {
      out += s;
    };
    const re = (r: RegExp | null | undefined): RegExp => {
      const x = r ?? lastRe;
      if (!x) throw new SedError('no previous regular expression');
      lastRe = x;
      return x;
    };
    const matchAddr = (a: Address, ps: string): boolean => {
      switch (a.k) {
        case 'line':
          return lineNo === a.n;
        case 'last':
          return isLast();
        case 're': {
          const r = re(a.re);
          r.lastIndex = 0;
          return r.test(ps);
        }
        case 'step':
          return a.step <= 0
            ? lineNo === a.first
            : lineNo >= a.first && (lineNo - a.first) % a.step === 0;
        case 'zero':
          return false;
      }
    };
    const selected = (c: Cmd, ps: string): boolean => {
      let r: boolean;
      if (!c.a1) r = true;
      else if (!c.a2) r = matchAddr(c.a1, ps);
      else if (c.active) {
        const a2 = c.a2;
        r = true;
        if (a2.k === 'line') {
          if (lineNo >= a2.n) c.active = false;
        } else if (a2.k === 'plus' || a2.k === 'mult') {
          if (lineNo >= (c.endLine ?? 0)) c.active = false;
        } else if (matchAddr(a2, ps)) {
          c.active = false;
        }
      } else if (c.a1.k === 'zero') {
        // 0,/re/: active from the first line, so the end regex may match line 1 itself.
        // endLine marks the range as used; it never restarts.
        if (c.endLine !== undefined) r = false;
        else {
          c.endLine = -1;
          c.active = !matchAddr(c.a2 as Address, ps);
          r = true;
        }
      } else {
        const start = matchAddr(c.a1, ps);
        if (start) {
          r = true;
          const a2 = c.a2;
          if (a2.k === 'line') c.active = a2.n > lineNo;
          else if (a2.k === 'plus') {
            c.endLine = lineNo + a2.n;
            c.active = a2.n > 0;
          } else if (a2.k === 'mult') {
            const end = a2.n > 0 ? Math.ceil(lineNo / a2.n) * a2.n : lineNo;
            c.endLine = end;
            c.active = end > lineNo;
          } else if (a2.k === 'last') c.active = !isLast();
          else c.active = true;
        } else r = false;
      }
      return c.negate ? !r : r;
    };

    let ps: string | null = null;
    let lineHadNewline = true;
    let appendQueue: string[] = [];
    const flushAppend = () => {
      for (const a of appendQueue) write(a);
      appendQueue = [];
    };
    const readNext = (): boolean => {
      const l = lines[idx];
      if (!l) return false;
      idx++;
      lineNo++;
      ps = l.text;
      lineHadNewline = l.newline;
      return true;
    };
    const emitPs = () => write(ps! + (lineHadNewline || !isLast() ? delim : ''));

    let unitIndex = -1;
    const finishUnit = async (ui: number) => {
      if (inPlace === null) return;
      const name = group[ui]!.name;
      const path = resolvePath(ctx.cwd, name);
      if (inPlace) {
        try {
          ctx.fs.copyFileSync(path, resolvePath(ctx.cwd, name + inPlace));
        } catch {
          // backup failures are reported by the write below if fatal
        }
      }
      ctx.fs.writeFileSync(path, out);
      out = '';
    };

    while (quitCode === null && readNext()) {
      const curUnit = lines[idx - 1]!.unit;
      if (curUnit !== unitIndex) {
        if (unitIndex >= 0) await finishUnit(unitIndex);
        unitIndex = curUnit;
      }
      let pc = 0;
      let substituted = false;
      let deleted = false;
      let restart = false;
      cycle: while (pc < cmds.length) {
        const c = cmds[pc]!;
        if (c.name === '}' || c.name === ':') {
          pc++;
          continue;
        }
        let sel: boolean;
        try {
          sel = selected(c, ps!);
        } catch (err) {
          if (err instanceof SedError) {
            await complain(ctx, err.message);
            return 1;
          }
          throw err;
        }
        if (!sel) {
          pc = c.name === '{' ? c.block! + 1 : pc + 1;
          continue;
        }
        switch (c.name) {
          case '{':
            break;
          case '=':
            write(`${lineNo}\n`);
            break;
          case 'a':
            appendQueue.push(`${c.text}\n`);
            break;
          case 'i':
            write(`${c.text}\n`);
            break;
          case 'c':
            // With a range, print the text at the end of the range only.
            if (!c.a2 || !c.active) write(`${c.text}\n`);
            deleted = true;
            break cycle;
          case 'd':
            deleted = true;
            break cycle;
          case 'D': {
            const nl = ps!.indexOf('\n');
            if (nl < 0) {
              deleted = true;
              break cycle;
            }
            ps = ps!.slice(nl + 1);
            restart = true;
            break cycle;
          }
          case 'p':
            emitPs();
            break;
          case 'P': {
            const nl = ps!.indexOf('\n');
            write((nl < 0 ? ps! : ps!.slice(0, nl)) + '\n');
            break;
          }
          case 'l':
            write(`${escapeL(ps!)}\n`);
            break;
          case 'h':
            hold = ps!;
            break;
          case 'H':
            hold += `\n${ps}`;
            break;
          case 'g':
            ps = hold;
            break;
          case 'G':
            ps += `\n${hold}`;
            break;
          case 'x': {
            const t = ps!;
            ps = hold;
            hold = t;
            break;
          }
          case 'z':
            ps = '';
            break;
          case 'F':
            write(`${group[curUnit]?.name ?? '-'}\n`);
            break;
          case 'n':
            if (!quiet) emitPs();
            flushAppend();
            if (isLast()) {
              // No next line: GNU sed ends without running the rest of the script.
              deleted = true;
              idx = lines.length;
              break cycle;
            }
            readNext();
            break;
          case 'N':
            flushAppend();
            if (isLast()) {
              // GNU prints the pattern space when N hits end of input.
              break cycle;
            }
            {
              const prev: string = ps!;
              readNext();
              ps = `${prev}\n${ps}`;
            }
            break;
          case 'q':
            quitCode = c.exitCode ?? 0;
            break cycle;
          case 'Q':
            quitCode = c.exitCode ?? 0;
            deleted = true;
            break cycle;
          case 'r':
            try {
              appendQueue.push(decode(ctx.fs.readFileSync(resolvePath(ctx.cwd, c.wfile!))));
            } catch {
              // missing files are silently ignored
            }
            break;
          case 'w':
            pushW(wfiles, c.wfile!, `${ps}\n`);
            break;
          case 'y': {
            let s = '';
            for (const ch of ps!) {
              const k = c.ysrc!.indexOf(ch);
              s += k >= 0 ? c.ydst![k] : ch;
            }
            ps = s;
            break;
          }
          case 'b':
            pc = c.label ? labels.get(c.label)! : cmds.length;
            continue;
          case 't':
          case 'T': {
            const jump = c.name === 't' ? substituted : !substituted;
            substituted = false;
            if (jump) {
              pc = c.label ? labels.get(c.label)! : cmds.length;
              continue;
            }
            break;
          }
          case 's': {
            let r: RegExp;
            try {
              r = re(c.re);
            } catch (err) {
              await complain(ctx, (err as Error).message);
              return 1;
            }
            const g = new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`);
            let result = '';
            let last = 0;
            let count = 0;
            let did = false;
            g.lastIndex = 0;
            for (let m = g.exec(ps!); m !== null; m = g.exec(ps!)) {
              count++;
              const empty = m[0] === '';
              if (count >= c.nth! && (c.global || count === c.nth)) {
                result += ps!.slice(last, m.index) + expandReplacement(c.replacement!, m);
                last = m.index + m[0].length;
                did = true;
                if (!c.global) break;
              }
              if (empty) {
                if (g.lastIndex >= ps!.length) break;
                g.lastIndex++;
              }
            }
            if (did) {
              ps = result + ps!.slice(last);
              substituted = true;
              for (let k = 0; k < c.print!; k++) emitPs();
              if (c.wfile) pushW(wfiles, c.wfile, `${ps}\n`);
            }
            break;
          }
        }
        pc++;
      }
      if (restart) {
        // D: restart the cycle without reading input when text remains.
        if (!quiet) {
          // GNU D prints nothing extra; the remaining text is reprocessed.
        }
        flushAppend();
        idx--;
        lineNo--;
        lines[idx] = { text: ps!, newline: lineHadNewline, unit: curUnit };
        continue;
      }
      if (!deleted && !quiet) emitPs();
      flushAppend();
      if (out.length > 65536 && inPlace === null) {
        await ctx.stdout.write(out);
        out = '';
      }
    }
    if (inPlace !== null) {
      if (unitIndex >= 0) await finishUnit(unitIndex);
      // Units with no lines still get rewritten (to empty).
      for (let ui = unitIndex + 1; ui < group.length; ui++) {
        if (group[ui]!.lines.length === 0)
          ctx.fs.writeFileSync(resolvePath(ctx.cwd, group[ui]!.name), '');
      }
    } else if (out) await ctx.stdout.write(out);
  }
  for (const [file, chunks] of wfiles) {
    try {
      ctx.fs.writeFileSync(resolvePath(ctx.cwd, file), chunks.join(''));
    } catch (err) {
      await complain(ctx, `couldn't open file ${quoteName(file)}: ${strerror(err)}`);
      status = 4;
    }
  }
  return quitCode ?? status;
}

function pushW(map: Map<string, string[]>, file: string, s: string): void {
  if (file === '/dev/stdout' || file === '/dev/stderr') {
    // handled as regular output would need the sink; approximate by collecting
  }
  let list = map.get(file);
  if (!list) map.set(file, (list = []));
  list.push(s);
}
