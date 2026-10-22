// SPDX-License-Identifier: Apache-2.0
// The shell interpreter. Runs a parsed script against a ShellHost: builtins
// and in-process commands execute here; anything else is spawned as a
// separate process. Subshells and pipeline stages are in-process copies of
// the shell state, as `fork()` would give them.

import type { ShellFs } from './types.ts';
import { ArithError, evaluateArith } from './arith.ts';
import type {
  ArithFor,
  Case,
  Command,
  CondExpr,
  For,
  If,
  List,
  Loop,
  ParamPart,
  Pipeline,
  Redirect,
  SimpleCommand,
  Word,
  WordPart,
} from './ast.ts';
import { BUILTINS, SPECIAL_BUILTINS } from './builtins.ts';
import { testFileOp, testBinaryOp } from './commands/test.ts';
import { errorCode, fileSource, resolvePath, strerror } from './commands/util.ts';
import {
  BrokenPipe,
  BufferedSource,
  CollectSink,
  Pipe,
  SIGPIPE_STATUS,
  bytesSource,
  emptySource,
  macrotask,
} from './io.ts';
import type { Sink, Source } from './io.ts';
import { ParseError, ScriptReader, parse, parseExpandable } from './parser.ts';
import {
  bracketToRegex,
  escapePattern,
  hasGlob,
  matchPattern,
  patternToRegex,
  replacePattern,
  trimPattern,
  unescapePattern,
} from './pattern.ts';
import type { CommandContext, CommandFn, ExecOptions, Spawner } from './types.ts';
import { BUILTIN_MARKER } from '@clientvm/protocol';

// ------------------------------------------------------------------ signals

/** Thrown to leave the shell (`exit`, fatal errors, `set -e`). */
export class ShellExit {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}
export class BreakSignal {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
export class ContinueSignal {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
export class ReturnSignal {
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}
/** An error that aborts the current command with a message (e.g. a bad redirect). */
export class CommandError extends Error {
  readonly status: number;
  /** Non-interactive shells exit on these (expansion errors). */
  readonly fatal: boolean;
  constructor(message: string, status = 1, fatal = false) {
    super(message);
    this.status = status;
    this.fatal = fatal;
  }
}

// -------------------------------------------------------------------- state

export interface Var {
  value: string;
  exported: boolean;
  readonly: boolean;
  integer?: boolean;
}

export interface ShellOptionFlags {
  errexit: boolean;
  nounset: boolean;
  xtrace: boolean;
  noglob: boolean;
  noclobber: boolean;
  allexport: boolean;
  pipefail: boolean;
  verbose: boolean;
  nullglob: boolean;
  dotglob: boolean;
  failglob: boolean;
  nocasematch: boolean;
}

const DEFAULT_IFS = ' \t\n';
/** execvp's search path when PATH is unset. */
const EXECVP_PATH = '/usr/local/bin:/usr/bin:/bin';

export class ShellState {
  vars = new Map<string, Var>();
  functions = new Map<string, Command>();
  aliases = new Map<string, string>();
  /** Names exported while unset (`export X`); exported once assigned. */
  pendingExport = new Set<string>();
  positional: string[] = [];
  arg0 = 'sh';
  cwd = '/';
  opts: ShellOptionFlags = {
    errexit: false,
    nounset: false,
    xtrace: false,
    noglob: false,
    noclobber: false,
    allexport: false,
    pipefail: false,
    verbose: false,
    nullglob: false,
    dotglob: false,
    failglob: false,
    nocasematch: false,
  };
  status = 0;
  lastBg: number | null = null;
  /** Saved values for `local`, one frame per active function call. */
  locals: Map<string, Var | undefined>[] = [];
  traps = new Map<string, string>();
  dirStack: string[] = [];
  getopts = { index: 1, sub: 0 };

  clone(): ShellState {
    const s = new ShellState();
    for (const [k, v] of this.vars) s.vars.set(k, { ...v });
    s.functions = new Map(this.functions);
    s.aliases = new Map(this.aliases);
    s.pendingExport = new Set(this.pendingExport);
    s.positional = [...this.positional];
    s.arg0 = this.arg0;
    s.cwd = this.cwd;
    s.opts = { ...this.opts };
    s.status = this.status;
    s.lastBg = this.lastBg;
    s.locals = this.locals.map((m) => new Map(m));
    // Traps other than ignored ones reset in subshells.
    s.dirStack = [...this.dirStack];
    return s;
  }
}

// ---------------------------------------------------------------------- io

interface Fd {
  r?: Source;
  w?: Sink;
}

const badFdSink = (fd: number): Sink => ({
  write() {
    throw new CommandError(`${fd}: Bad file descriptor`);
  },
});

export class Io {
  readonly fds: Map<number, Fd>;
  constructor(fds: Map<number, Fd>) {
    this.fds = fds;
  }
  static of(stdin: Source, stdout: Sink, stderr: Sink): Io {
    return new Io(
      new Map([
        [0, { r: stdin }],
        [1, { w: stdout }],
        [2, { w: stderr }],
      ]),
    );
  }
  get stdin(): Source {
    return this.fds.get(0)?.r ?? emptySource();
  }
  get stdout(): Sink {
    return this.fds.get(1)?.w ?? badFdSink(1);
  }
  get stderr(): Sink {
    return this.fds.get(2)?.w ?? badFdSink(2);
  }
  with(fd: number, entry: Fd): Io {
    const fds = new Map(this.fds);
    fds.set(fd, entry);
    return new Io(fds);
  }
  clone(): Io {
    return new Io(new Map(this.fds));
  }
}

// --------------------------------------------------------------------- host

export interface ShellHost {
  fs: ShellFs;
  spawn: Spawner;
  /** Commands that run in-process when PATH resolves to their marker file. */
  commands: Readonly<Record<string, CommandFn>>;
  /** This shell's pid ($$). */
  pid: number;
  ppid?: number;
}

interface Job {
  id: number;
  pid: number;
  command: string;
  done: Promise<number>;
  status: number | null;
}

type Resolved =
  | { kind: 'inprocess'; path: string; fn: CommandFn }
  | { kind: 'external'; path: string }
  | { kind: 'error'; status: number; message: string };

interface Field {
  text: string;
  pattern: string;
  glob: boolean;
  started: boolean;
}

const newField = (): Field => ({ text: '', pattern: '', glob: false, started: false });

/** Collects fields during expansion, applying IFS splitting to unquoted expansions. */
class Fields {
  readonly out: Field[] = [];
  cur: Field = newField();
  private justWs = false;
  readonly split: boolean;
  readonly ifs: string;

  constructor(split: boolean, ifs: string) {
    this.split = split;
    this.ifs = ifs;
  }

  quoted(s: string): void {
    this.cur.text += s;
    this.cur.pattern += escapePattern(s);
    this.cur.started = true;
    this.justWs = false;
  }

  literal(s: string): void {
    if (!s) return;
    this.cur.text += s;
    this.cur.pattern += s;
    if (!this.cur.glob && hasGlob(s)) this.cur.glob = true;
    this.cur.started = true;
    this.justWs = false;
  }

  /** Text produced by an unquoted expansion: split on IFS, still glob-active. */
  expansion(s: string): void {
    if (!this.split) {
      this.literal(s.replace(/\\/g, '\\\\'));
      return;
    }
    const ifs = this.ifs;
    let run = '';
    const flushRun = () => {
      if (run) this.literal(run.replace(/\\/g, '\\\\'));
      run = '';
    };
    for (const c of s) {
      if (!ifs.includes(c)) {
        run += c;
        continue;
      }
      flushRun();
      if (c === ' ' || c === '\t' || c === '\n') {
        if (this.cur.started) {
          this.push();
          this.justWs = true;
        }
      } else {
        if (this.justWs) this.justWs = false;
        else this.push();
      }
    }
    flushRun();
  }

  push(): void {
    this.out.push(this.cur);
    this.cur = newField();
  }

  finish(): Field[] {
    if (this.cur.started) this.push();
    return this.out;
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface RunOptions {
  /** Start of line numbering (for scripts sourced at an offset). */
  line?: number;
}

export class Shell {
  readonly host: ShellHost;
  state: ShellState;
  /** Current line (for messages and $LINENO). */
  line = 1;
  /** Name used in error messages: `sh`, `bash` or the script path. */
  scriptName: string;
  /** True for `sh -c` (syntax errors then read `sh: -c: line N:`). */
  commandString = false;
  /** True while running a script file (messages then omit the `-c` form). */
  private loopDepth = 0;
  private funcDepth = 0;
  private sourceDepth = 0;
  /** Exit status of the last command substitution in the current command. */
  private substStatus: number | null = null;
  private readonly jobs = new Map<number, Job>();
  private nextJob = 1;
  private readonly startTime = Date.now();
  private tempFiles: string[] = [];
  private static nextPid = 10000;
  private static nextTemp = 1;

  constructor(host: ShellHost, state: ShellState, scriptName: string) {
    this.host = host;
    this.state = state;
    this.scriptName = scriptName;
  }

  /** Creates a top-level shell with variables imported from `env`. */
  static create(
    host: ShellHost,
    options: {
      env: Record<string, string>;
      cwd: string;
      arg0: string;
      args?: string[];
      scriptName?: string;
    },
  ): Shell {
    const state = new ShellState();
    for (const [k, v] of Object.entries(options.env)) {
      if (NAME_RE.test(k)) state.vars.set(k, { value: v, exported: true, readonly: false });
    }
    state.cwd = options.cwd;
    state.arg0 = options.arg0;
    state.positional = options.args ?? [];
    const set = (k: string, v: string, exported = false) => {
      const existing = state.vars.get(k);
      state.vars.set(k, { value: v, exported: existing?.exported ?? exported, readonly: false });
    };
    set('PWD', options.cwd, true);
    if (!state.vars.has('IFS')) set('IFS', DEFAULT_IFS);
    set('PS4', '+ ');
    set('OPTIND', '1');
    set('PPID', String(host.ppid ?? 1));
    if (!state.vars.has('PATH')) set('PATH', '/usr/local/bin:/usr/bin:/bin');
    if (options.arg0 === 'bash' || options.arg0.endsWith('/bash')) {
      set('BASH', '/bin/bash');
      set('BASH_VERSION', '5.2.21(1)-release');
    }
    return new Shell(host, state, options.scriptName ?? options.arg0);
  }

  get fs(): ShellFs {
    return this.host.fs;
  }

  subshell(): Shell {
    const sub = new Shell(this.host, this.state.clone(), this.scriptName);
    sub.line = this.line;
    sub.funcDepth = this.funcDepth;
    sub.sourceDepth = this.sourceDepth;
    return sub;
  }

  // ------------------------------------------------------------ entry points

  /**
   * Parses and runs a script. Returns the exit status; runs the EXIT trap.
   * Syntax errors print a message and return 2 (without running anything).
   */
  async run(src: string, io: Io, options: RunOptions = {}): Promise<number> {
    const firstLine = options.line ?? 1;
    // Like bash, read the script as if it ended with a newline.
    const reader = new ScriptReader(src.endsWith('\n') ? src : `${src}\n`, firstLine);
    let status = 0;
    try {
      for (;;) {
        let list: List | null;
        try {
          list = reader.next();
        } catch (err) {
          if (err instanceof ParseError) {
            await this.reportSyntax(io, err, src, firstLine, this.commandString ? '-c' : null);
            return this.exitWith(2, io);
          }
          throw err;
        }
        if (!list) break;
        status = await this.runList(list, io);
      }
    } catch (err) {
      status = await this.topLevelStatus(err, io);
    }
    return this.exitWith(status, io);
  }

  /** bash's two-line syntax error report: the message, then the offending line. */
  async reportSyntax(
    io: Io,
    err: ParseError,
    src: string,
    firstLine: number,
    label: string | null,
  ): Promise<void> {
    const prefix = `${this.scriptName}: ${label ? `${label}: ` : ''}line ${err.line}: `;
    let text = `${prefix}${err.message}\n`;
    if (!err.incomplete) {
      const lineText = src.split('\n')[err.line - firstLine];
      if (lineText !== undefined) text += `${prefix}\`${lineText}'\n`;
    }
    await io.stderr.write(text);
  }

  /** Runs the EXIT trap and returns the final status. */
  async exitWith(status: number, io: Io): Promise<number> {
    const trap = this.state.traps.get('EXIT');
    if (trap) {
      this.state.traps.delete('EXIT');
      this.state.status = status;
      try {
        await this.runString(trap, io);
      } catch (err) {
        if (err instanceof ShellExit) status = err.status;
        else if (!(
          err instanceof ReturnSignal ||
          err instanceof BreakSignal ||
          err instanceof ContinueSignal
        ))
          throw err;
      }
    }
    this.cleanupTemp();
    return status;
  }

  private async topLevelStatus(err: unknown, io: Io): Promise<number> {
    if (err instanceof ShellExit) return err.status;
    if (err instanceof ReturnSignal) return err.status;
    if (err instanceof BreakSignal || err instanceof ContinueSignal) return this.state.status;
    if (err instanceof CommandError) {
      await this.report(io, err.message).catch(() => {});
      return err.status;
    }
    if (err instanceof BrokenPipe) return SIGPIPE_STATUS;
    throw err;
  }

  /** Parses and runs a string in this shell (eval, source, traps). */
  async runString(src: string, io: Io, firstLine = this.line, label = 'eval'): Promise<number> {
    let list: List;
    try {
      list = parse(src, firstLine);
    } catch (err) {
      if (err instanceof ParseError) {
        await this.reportSyntax(io, err, src, firstLine, label);
        return 2;
      }
      throw err;
    }
    return this.runList(list, io);
  }

  /** Writes `<name>: line N: message`. */
  async report(io: Io, message: string, line = this.line): Promise<void> {
    await io.stderr.write(`${this.scriptName}: line ${line}: ${message}\n`);
  }

  // ------------------------------------------------------------------ lists

  async runList(list: List, io: Io, cond = false): Promise<number> {
    let status = 0;
    for (const item of list.items) {
      if (item.background) {
        status = this.startBackground(item.cmd, io);
        continue;
      }
      status = await this.runAndOr(item.cmd, io, cond);
    }
    return status;
  }

  private startBackground(cmd: List['items'][number]['cmd'], io: Io): number {
    const sub = this.subshell();
    const pid = Shell.nextPid++;
    // Non-interactive shells give background jobs /dev/null as stdin.
    const bgIo = io.with(0, { r: emptySource() });
    const job: Job = {
      id: this.nextJob++,
      pid,
      command: '',
      status: null,
      done: Promise.resolve(0),
    };
    job.done = (async () => {
      let status: number;
      try {
        status = await sub.runAndOr(cmd, bgIo, false);
      } catch (err) {
        try {
          status = await sub.topLevelStatus(err, bgIo);
        } catch {
          status = 1;
        }
      }
      job.status = status;
      return status;
    })();
    this.jobs.set(pid, job);
    this.state.lastBg = pid;
    this.state.status = 0;
    return 0;
  }

  private async runAndOr(
    andor: List['items'][number]['cmd'],
    io: Io,
    cond: boolean,
  ): Promise<number> {
    const hasRest = andor.rest.length > 0;
    let status = await this.runPipeline(andor.first, io, cond || hasRest);
    for (let i = 0; i < andor.rest.length; i++) {
      const { op, pipeline } = andor.rest[i]!;
      if ((op === '&&') !== (status === 0)) continue;
      const last = i === andor.rest.length - 1;
      status = await this.runPipeline(pipeline, io, cond || !last);
    }
    this.state.status = status;
    return status;
  }

  async runPipeline(p: Pipeline, io: Io, cond: boolean): Promise<number> {
    let status: number;
    const innerCond = cond || p.bang;
    if (p.commands.length === 1) {
      status = await this.runCommand(p.commands[0]!, io, innerCond);
    } else {
      status = await this.runMulti(p, io, innerCond);
    }
    if (p.bang) status = status === 0 ? 1 : 0;
    this.state.status = status;
    if (!innerCond && status !== 0 && this.state.opts.errexit) throw new ShellExit(status);
    return status;
  }

  private async runMulti(p: Pipeline, io: Io, cond: boolean): Promise<number> {
    const n = p.commands.length;
    const pipes: Pipe[] = [];
    for (let i = 0; i < n - 1; i++) pipes.push(new Pipe());
    const stages = p.commands.map(async (cmd, i) => {
      let stageIo = io;
      if (i > 0) stageIo = stageIo.with(0, { r: pipes[i - 1]!.source });
      if (i < n - 1) {
        const w = pipes[i]!.sink;
        stageIo = stageIo.with(1, { w });
        if (p.stderrToo[i]) stageIo = stageIo.with(2, { w });
      }
      const sub = this.subshell();
      let status: number;
      try {
        status = await sub.runCommand(cmd, stageIo, cond);
      } catch (err) {
        status = await sub.topLevelStatus(err, stageIo);
      } finally {
        if (i < n - 1) pipes[i]!.closeWriter();
        if (i > 0) pipes[i - 1]!.source.close();
      }
      return status;
    });
    const statuses = await Promise.all(stages);
    if (this.state.opts.pipefail) {
      for (let i = statuses.length - 1; i >= 0; i--) if (statuses[i] !== 0) return statuses[i]!;
      return 0;
    }
    return statuses[n - 1]!;
  }

  // --------------------------------------------------------------- commands

  async runCommand(cmd: Command, io: Io, cond: boolean): Promise<number> {
    if (cmd.type === 'simple') return this.runSimple(cmd, io, cond);
    if (cmd.type === 'function') {
      this.state.functions.set(cmd.name, cmd.body);
      return 0;
    }
    let redirected: { io: Io; cleanup: () => void };
    try {
      redirected = await this.redirect(cmd.redirects, io);
    } catch (err) {
      if (err instanceof CommandError && !err.fatal) {
        await this.report(io, err.message);
        return err.status;
      }
      throw err;
    }
    try {
      return await this.runCompound(cmd, redirected.io, cond);
    } finally {
      redirected.cleanup();
    }
  }

  private async runCompound(
    cmd: Exclude<Command, SimpleCommand | { type: 'function' }>,
    io: Io,
    cond: boolean,
  ): Promise<number> {
    switch (cmd.type) {
      case 'group':
        return this.runList(cmd.body, io, cond);
      case 'subshell': {
        const sub = this.subshell();
        try {
          return await sub.exitWith(await sub.runList(cmd.body, io, cond), io);
        } catch (err) {
          return sub.exitWith(await sub.topLevelStatus(err, io), io);
        }
      }
      case 'if':
        return this.runIf(cmd, io, cond);
      case 'while':
      case 'until':
        return this.runLoop(cmd, io, cond);
      case 'for':
        return this.runFor(cmd, io, cond);
      case 'arith-for':
        return this.runArithFor(cmd, io, cond);
      case 'case':
        return this.runCase(cmd, io, cond);
      case 'cond': {
        this.line = cmd.line;
        const status = (await this.evalCond(cmd.expr, io)) ? 0 : 1;
        this.state.status = status;
        return status;
      }
      case 'arith-cmd': {
        this.line = cmd.line;
        try {
          const v = await this.arith(cmd.expr, io);
          this.state.status = v === 0n ? 1 : 0;
          return this.state.status;
        } catch (err) {
          if (err instanceof ArithError) {
            await this.report(io, err.message);
            return 1;
          }
          throw err;
        }
      }
    }
  }

  private async runIf(cmd: If, io: Io, cond: boolean): Promise<number> {
    for (const clause of cmd.clauses) {
      if ((await this.runList(clause.cond, io, true)) === 0)
        return this.runList(clause.body, io, cond);
    }
    if (cmd.else) return this.runList(cmd.else, io, cond);
    return 0;
  }

  /** Runs a loop body; returns 'break' / 'continue' / undefined for flow control. */
  private async loopBody(
    body: List,
    io: Io,
    cond: boolean,
  ): Promise<{ status: number; flow?: 'break' }> {
    try {
      return { status: await this.runList(body, io, cond) };
    } catch (err) {
      if (err instanceof BreakSignal) {
        if (err.n > 1) {
          err.n--;
          throw err;
        }
        return { status: 0, flow: 'break' };
      }
      if (err instanceof ContinueSignal) {
        if (err.n > 1) {
          err.n--;
          throw err;
        }
        return { status: 0 };
      }
      throw err;
    }
  }

  private async runLoop(cmd: Loop, io: Io, cond: boolean): Promise<number> {
    let status = 0;
    this.loopDepth++;
    try {
      for (;;) {
        const c = await this.runList(cmd.cond, io, true);
        if ((c === 0) !== (cmd.type === 'while')) break;
        const r = await this.loopBody(cmd.body, io, cond);
        status = r.status;
        if (r.flow === 'break') break;
        await yieldToEventLoop();
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  private async runFor(cmd: For, io: Io, cond: boolean): Promise<number> {
    const items = cmd.words ? await this.expandWords(cmd.words, io) : [...this.state.positional];
    let status = 0;
    this.loopDepth++;
    try {
      for (const item of items) {
        this.setVar(cmd.name, item);
        const r = await this.loopBody(cmd.body, io, cond);
        status = r.status;
        if (r.flow === 'break') break;
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  private async runArithFor(cmd: ArithFor, io: Io, cond: boolean): Promise<number> {
    let status = 0;
    this.loopDepth++;
    try {
      if (cmd.init) await this.arith(cmd.init, io);
      for (;;) {
        if (cmd.cond && (await this.arith(cmd.cond, io)) === 0n) break;
        const r = await this.loopBody(cmd.body, io, cond);
        status = r.status;
        if (r.flow === 'break') break;
        if (cmd.step) await this.arith(cmd.step, io);
        await yieldToEventLoop();
      }
    } catch (err) {
      if (err instanceof ArithError) {
        await this.report(io, err.message);
        return 1;
      }
      throw err;
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  private async runCase(cmd: Case, io: Io, cond: boolean): Promise<number> {
    const subject = await this.expandString(cmd.word, io);
    let status = 0;
    let fallthrough = false;
    for (const item of cmd.items) {
      let matched = fallthrough;
      if (!matched) {
        for (const pat of item.patterns) {
          if (
            matchPattern(await this.expandPattern(pat, io), subject, this.state.opts.nocasematch)
          ) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) continue;
      status = await this.runList(item.body, io, cond);
      if (item.terminator === ';;') return status;
      fallthrough = item.terminator === ';&';
    }
    return status;
  }

  // ---------------------------------------------------------- [[ ... ]]

  private async evalCond(e: CondExpr, io: Io): Promise<boolean> {
    switch (e.k) {
      case 'and':
        return (await this.evalCond(e.left, io)) && this.evalCond(e.right, io);
      case 'or':
        return (await this.evalCond(e.left, io)) || this.evalCond(e.right, io);
      case 'not':
        return !(await this.evalCond(e.expr, io));
      case 'word':
        return (await this.expandString(e.word, io)) !== '';
      case 'unary': {
        const arg = await this.expandString(e.arg, io);
        if (e.op === '-z') return arg === '';
        if (e.op === '-n') return arg !== '';
        if (e.op === '-v') return this.state.vars.has(arg) || this.getParam(arg) !== undefined;
        if (e.op === '-o') return this.optionEnabled(arg);
        if (e.op === '-t') return false;
        return testFileOp(this.fs, e.op, resolvePath(this.state.cwd, arg));
      }
      case 'binary': {
        const left = await this.expandString(e.left, io);
        switch (e.op) {
          case '==':
          case '=':
          case '!=': {
            const pat = await this.expandPattern(e.right, io);
            const m = matchPattern(pat, left, this.state.opts.nocasematch);
            return e.op === '!=' ? !m : m;
          }
          case '=~':
            return this.regexMatch(left, e.right, io);
          case '<':
            return left < (await this.expandString(e.right, io));
          case '>':
            return left > (await this.expandString(e.right, io));
          case '-eq':
          case '-ne':
          case '-lt':
          case '-le':
          case '-gt':
          case '-ge': {
            const right = await this.expandString(e.right, io);
            const a = await this.arithString(left);
            const b = await this.arithString(right);
            return compareInts(e.op, a, b);
          }
          default: {
            const right = await this.expandString(e.right, io);
            return testBinaryOp(
              this.fs,
              e.op,
              resolvePath(this.state.cwd, left),
              resolvePath(this.state.cwd, right),
            );
          }
        }
      }
    }
  }

  private async regexMatch(subject: string, word: Word, io: Io): Promise<boolean> {
    // Quoted parts match literally; unquoted parts are an ERE.
    let src = '';
    const visit = async (parts: WordPart[], quoted: boolean) => {
      for (const p of parts) {
        if (p.t === 'lit') src += quoted ? escapeRe(p.v) : p.v;
        else if (p.t === 'sq') src += escapeRe(p.v);
        else if (p.t === 'dq') await visit(p.parts, true);
        else {
          const v = await this.expandString({ parts: [p] }, io);
          src += quoted ? escapeRe(v) : v;
        }
      }
    };
    await visit(word.parts, false);
    let re: RegExp;
    try {
      re = new RegExp(eregToJs(src), this.state.opts.nocasematch ? 'i' : '');
    } catch {
      return false;
    }
    const m = re.exec(subject);
    if (!m) return false;
    // BASH_REMATCH is an array in bash; we expose element 0 and BASH_REMATCH_<n>.
    this.setVar('BASH_REMATCH', m[0]);
    return true;
  }

  private optionEnabled(name: string): boolean {
    const opts = this.state.opts as unknown as Record<string, boolean>;
    return opts[name] === true;
  }

  // --------------------------------------------------------- simple commands

  private async runSimple(cmd: SimpleCommand, io: Io, cond: boolean): Promise<number> {
    this.line = cmd.line;
    this.substStatus = null;
    let argv: string[];
    const assigns: [string, string, boolean][] = [];
    try {
      argv = await this.expandWords(cmd.words, io);
      for (const a of cmd.assigns)
        assigns.push([a.name, await this.expandAssignment(a.value, io), a.append]);
    } catch (err) {
      return this.commandFailed(err, io);
    }
    const tempFiles = this.tempFiles;
    this.tempFiles = [];
    try {
      if (argv.length === 0) {
        if (this.state.opts.xtrace && assigns.length > 0) {
          await this.trace(
            io,
            assigns.map(([k, v, append]) => `${k}${append ? '+' : ''}=${v}`),
          );
        }
        for (const [name, value, append] of assigns) {
          const err = this.assign(name, value, append);
          if (err) {
            // A failed assignment is fatal in a non-interactive shell.
            await this.report(io, err);
            throw new ShellExit(1);
          }
        }
        let r: { io: Io; cleanup: () => void };
        try {
          r = await this.redirect(cmd.redirects, io);
        } catch (err) {
          return this.commandFailed(err, io);
        }
        r.cleanup();
        return this.substStatus ?? 0;
      }

      if (this.state.opts.xtrace) {
        await this.trace(io, [...assigns.map(([k, v]) => `${k}=${v}`), ...argv]);
      }

      const name = argv[0]!;
      // `exec` with only redirections changes this shell's own fds.
      if (name === 'exec' && argv.length === 1) {
        try {
          const r = await this.redirect(cmd.redirects, io);
          for (const [fd, entry] of r.io.fds) io.fds.set(fd, entry);
          for (const fd of [...io.fds.keys()]) if (!r.io.fds.has(fd)) io.fds.delete(fd);
        } catch (err) {
          return this.commandFailed(err, io);
        }
        return 0;
      }

      let r: { io: Io; cleanup: () => void };
      try {
        r = await this.redirect(cmd.redirects, io);
      } catch (err) {
        return this.commandFailed(err, io);
      }
      try {
        const special = SPECIAL_BUILTINS.has(name) && !this.state.functions.has(name);
        if (assigns.length > 0 && special) {
          // POSIX: assignments before special builtins persist.
          for (const [k, v, append] of assigns) this.assign(k, v, append);
          return await this.dispatch(argv, r.io, cond);
        }
        return await this.withTempAssigns(assigns, io, () => this.dispatch(argv, r.io, cond));
      } catch (err) {
        if (err instanceof BrokenPipe) return SIGPIPE_STATUS;
        if (err instanceof CommandError && !err.fatal) {
          await this.report(io, err.message);
          return err.status;
        }
        throw err;
      } finally {
        r.cleanup();
      }
    } finally {
      for (const f of this.tempFiles) this.removeTemp(f);
      this.tempFiles = tempFiles;
    }
  }

  private async commandFailed(err: unknown, io: Io): Promise<number> {
    if (err instanceof CommandError) {
      await this.report(io, err.message);
      if (err.fatal) throw new ShellExit(err.status);
      return err.status;
    }
    if (err instanceof ArithError) {
      await this.report(io, err.message);
      throw new ShellExit(1);
    }
    throw err;
  }

  private async trace(io: Io, words: string[]): Promise<void> {
    const ps4 = this.state.vars.get('PS4')?.value ?? '+ ';
    await io.stderr.write(`${ps4}${words.map(traceQuote).join(' ')}\n`);
  }

  private async withTempAssigns<T>(
    assigns: [string, string, boolean][],
    io: Io,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (assigns.length === 0) return fn();
    const saved: [string, Var | undefined][] = [];
    for (const [k, v, append] of assigns) {
      const old = this.state.vars.get(k);
      if (old?.readonly) {
        // bash reports it and runs the command anyway.
        await io.stderr.write(`${this.scriptName}: line ${this.line}: ${k}: readonly variable\n`);
        continue;
      }
      saved.push([k, old ? { ...old } : undefined]);
      const value = append ? (old?.value ?? '') + v : v;
      this.state.vars.set(k, { value, exported: true, readonly: false });
    }
    try {
      return await fn();
    } finally {
      for (const [k, old] of saved.reverse()) {
        if (old) this.state.vars.set(k, old);
        else this.state.vars.delete(k);
      }
    }
  }

  /** Runs argv: function, builtin, in-process command or external program. */
  async dispatch(argv: string[], io: Io, cond = false): Promise<number> {
    const name = argv[0]!;
    const fn = this.state.functions.get(name);
    if (fn) return this.callFunction(fn, argv, io, cond);
    const builtin = BUILTINS[name];
    if (builtin) return builtin(this, argv, io, cond);
    return this.execProgram(argv, io);
  }

  async callFunction(body: Command, argv: string[], io: Io, cond = false): Promise<number> {
    if (this.funcDepth >= 1000)
      throw new CommandError(`${argv[0]}: maximum function nesting level exceeded (1000)`, 1, true);
    const savedArgs = this.state.positional;
    const savedLoop = this.loopDepth;
    this.state.positional = argv.slice(1);
    this.state.locals.push(new Map());
    this.funcDepth++;
    this.loopDepth = 0;
    try {
      return await this.runCommand(body, io, cond);
    } catch (err) {
      if (err instanceof ReturnSignal) return err.status;
      throw err;
    } finally {
      this.funcDepth--;
      this.loopDepth = savedLoop;
      const frame = this.state.locals.pop()!;
      for (const [k, old] of frame) {
        if (old) this.state.vars.set(k, old);
        else this.state.vars.delete(k);
      }
      this.state.positional = savedArgs;
    }
  }

  get inFunction(): boolean {
    return this.funcDepth > 0;
  }
  get inLoop(): boolean {
    return this.loopDepth > 0;
  }
  get inSource(): boolean {
    return this.sourceDepth > 0;
  }

  /** Runs a program found by PATH lookup (no functions or builtins). */
  async execProgram(
    argv: readonly string[],
    io: Io,
    extraEnv?: Record<string, string>,
    searchPath?: string,
  ): Promise<number> {
    const name = argv[0]!;
    const resolved = this.resolveCommand(name, searchPath);
    if (resolved.kind === 'error') {
      await this.report(io, resolved.message);
      return resolved.status;
    }
    const env = { ...this.exportedEnv(), ...extraEnv };
    if (resolved.kind === 'inprocess') {
      const ctx = this.commandContext(argv, io, env, this.state.cwd);
      return runCommandFn(resolved.fn, ctx);
    }
    try {
      return await this.host.spawn([resolved.path, ...argv.slice(1)], {
        env,
        cwd: this.state.cwd,
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
      });
    } catch (err) {
      if (err instanceof BrokenPipe) return SIGPIPE_STATUS;
      const code = errorCode(err);
      if (code === 'ENOENT') {
        await this.report(io, `${name}: command not found`);
        return 127;
      }
      if (code === 'EACCES' || code === 'ENOEXEC') {
        await this.report(
          io,
          `${name}: ${code === 'EACCES' ? 'Permission denied' : 'cannot execute binary file: Exec format error'}`,
        );
        return 126;
      }
      await this.report(io, `${name}: ${strerror(err)}`);
      return 126;
    }
  }

  /** A CommandContext for an in-process command. */
  commandContext(
    argv: readonly string[],
    io: Io,
    env: Record<string, string>,
    cwd: string,
  ): CommandContext {
    return {
      argv,
      env,
      cwd,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      fs: this.fs,
      exec: (args: readonly string[], o: ExecOptions = {}) => {
        let sub = io;
        if (o.stdin) sub = sub.with(0, { r: o.stdin });
        if (o.stdout) sub = sub.with(1, { w: o.stdout });
        if (o.stderr) sub = sub.with(2, { w: o.stderr });
        const shell = this.subshell();
        if (o.cwd) shell.state.cwd = o.cwd;
        if (o.env) {
          for (const [k, v] of shell.state.vars)
            if (v.exported && !(k in o.env)) shell.state.vars.delete(k);
          for (const [k, v] of Object.entries(o.env))
            shell.state.vars.set(k, { value: v, exported: true, readonly: false });
        }
        // Commands exec like execvp: an unset PATH means the default search path.
        return shell.execProgram(
          args,
          sub,
          undefined,
          shell.state.vars.get('PATH')?.value ?? EXECVP_PATH,
        );
      },
    };
  }

  /** PATH lookup like execvp, deciding between in-process and spawned execution. */
  resolveCommand(name: string, searchPath?: string): Resolved {
    if (name === '') return { kind: 'error', status: 127, message: `: command not found` };
    let path: string | undefined;
    if (name.includes('/')) {
      path = resolvePath(this.state.cwd, name);
      const st = this.statOrNull(path);
      if (!st) return { kind: 'error', status: 127, message: `${name}: No such file or directory` };
      if (st.isDirectory())
        return { kind: 'error', status: 126, message: `${name}: Is a directory` };
      if ((st.mode & 0o111) === 0)
        return { kind: 'error', status: 126, message: `${name}: Permission denied` };
    } else {
      const pathVar = searchPath ?? this.state.vars.get('PATH')?.value;
      // bash with PATH unset looks only in the current directory.
      const PATH = pathVar ?? '';
      let denied: string | undefined;
      for (const dir of PATH.split(':')) {
        const candidate = resolvePath(this.state.cwd, dir === '' ? '.' : dir) + '/' + name;
        const st = this.statOrNull(candidate);
        if (!st || st.isDirectory()) continue;
        if ((st.mode & 0o111) === 0) {
          denied ??= candidate;
          continue;
        }
        path = candidate;
        break;
      }
      if (!path) {
        if (denied) return { kind: 'error', status: 126, message: `${denied}: Permission denied` };
        return {
          kind: 'error',
          status: 127,
          message: `${name}: ${pathVar === undefined ? 'No such file or directory' : 'command not found'}`,
        };
      }
    }
    const runtime = this.markerRuntime(path);
    if (runtime !== null) {
      const fn = this.host.commands[runtime];
      if (fn) return { kind: 'inprocess', path, fn };
    }
    return { kind: 'external', path };
  }

  private statOrNull(path: string) {
    try {
      return this.fs.statSync(path);
    } catch {
      return null;
    }
  }

  /** The runtime named by a builtin marker file, or null for any other file. */
  private markerRuntime(path: string): string | null {
    let fd: number;
    try {
      fd = this.fs.openSync(path, 'r');
    } catch {
      return null;
    }
    try {
      const buf = new Uint8Array(64);
      const n = this.fs.readSync(fd, buf, 0, 64, 0);
      const head = new TextDecoder().decode(buf.subarray(0, n));
      if (!head.startsWith(BUILTIN_MARKER)) return null;
      return head.slice(BUILTIN_MARKER.length).split('\n', 1)[0]!.trim();
    } finally {
      this.fs.closeSync(fd);
    }
  }

  // ---------------------------------------------------------------- variables

  exportedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of this.state.vars) if (v.exported) env[k] = v.value;
    return env;
  }

  /** Sets a variable; returns an error message for readonly variables. */
  setVar(name: string, value: string, opts: { exported?: boolean } = {}): string | null {
    const existing = this.state.vars.get(name);
    if (existing?.readonly) return `${name}: readonly variable`;
    let v = value;
    if (existing?.integer) v = String(evaluateArith(value, this.arithScope()));
    this.state.vars.set(name, {
      value: v,
      exported:
        opts.exported ??
        existing?.exported ??
        (this.state.pendingExport.has(name) || this.state.opts.allexport),
      readonly: false,
      ...(existing?.integer ? { integer: true } : {}),
    });
    if (name === 'OPTIND') this.state.getopts = { index: Number(v) || 1, sub: 0 };
    return null;
  }

  private assign(name: string, value: string, append: boolean): string | null {
    if (append) {
      const old = this.state.vars.get(name);
      if (old?.integer) {
        return this.setVar(
          name,
          String(evaluateArith(`${old.value || 0}+(${value || 0})`, this.arithScope())),
        );
      }
      return this.setVar(name, (old?.value ?? '') + value);
    }
    return this.setVar(name, value);
  }

  unsetVar(name: string): string | null {
    const v = this.state.vars.get(name);
    if (v?.readonly) return `${name}: cannot unset: readonly variable`;
    this.state.vars.delete(name);
    return null;
  }

  /** `local name`: saves the current value in the function's frame. */
  declareLocal(name: string): void {
    const frame = this.state.locals[this.state.locals.length - 1];
    if (!frame) return;
    if (!frame.has(name)) {
      const old = this.state.vars.get(name);
      frame.set(name, old ? { ...old } : undefined);
    }
  }

  getVar(name: string): string | undefined {
    return this.getParam(name);
  }

  /** Value of a parameter, or undefined when unset. */
  getParam(name: string): string | undefined {
    if (/^[0-9]+$/.test(name)) {
      const n = Number(name);
      if (n === 0) return this.state.arg0;
      return this.state.positional[n - 1];
    }
    switch (name) {
      case '#':
        return String(this.state.positional.length);
      case '?':
        return String(this.state.status);
      case '$':
        return String(this.host.pid);
      case '!':
        return this.state.lastBg === null ? undefined : String(this.state.lastBg);
      case '-':
        return this.optionLetters();
      case '@':
      case '*':
        return this.state.positional.join(this.ifs()[0] ?? '');
    }
    const v = this.state.vars.get(name);
    if (v) return v.value;
    switch (name) {
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768));
      case 'SECONDS':
        return String(Math.floor((Date.now() - this.startTime) / 1000));
      case 'LINENO':
        return String(this.line);
      case 'EPOCHSECONDS':
        return String(Math.floor(Date.now() / 1000));
    }
    return undefined;
  }

  private optionLetters(): string {
    const o = this.state.opts;
    let s = '';
    if (o.allexport) s += 'a';
    if (o.errexit) s += 'e';
    if (o.noglob) s += 'f';
    s += 'h';
    if (o.nounset) s += 'u';
    if (o.verbose) s += 'v';
    if (o.xtrace) s += 'x';
    if (o.noclobber) s += 'C';
    return s + 'B';
  }

  ifs(): string {
    return this.state.vars.get('IFS')?.value ?? DEFAULT_IFS;
  }

  arithScope() {
    return {
      get: (name: string) => {
        const v = this.getParam(name);
        if (v === undefined && this.state.opts.nounset)
          throw new CommandError(
            `${/^[0-9]+$/.test(name) ? '$' : ''}${name}: unbound variable`,
            127,
            true,
          );
        return v;
      },
      set: (name: string, value: string) => {
        const err = this.setVar(name, value);
        if (err) throw new CommandError(err);
      },
    };
  }

  async arith(word: Word, io: Io): Promise<bigint> {
    const text = await this.expandString(word, io);
    return evaluateArith(text, this.arithScope());
  }

  private async arithString(text: string): Promise<bigint> {
    return evaluateArith(text, this.arithScope());
  }

  // --------------------------------------------------------------- expansion

  /** Full expansion to fields: brace, tilde, parameter, command, arithmetic, split, glob. */
  async expandWords(words: readonly Word[], io: Io): Promise<string[]> {
    const out: string[] = [];
    for (const w of words) {
      for (const braced of braceExpand(w)) {
        const f = new Fields(true, this.ifs());
        await this.expandParts(this.tildeExpand(braced.parts), f, false, io, false);
        for (const field of f.finish()) {
          if (field.glob && !this.state.opts.noglob) {
            const matches = this.glob(field.pattern);
            if (matches.length > 0) {
              out.push(...matches);
              continue;
            }
            if (this.state.opts.failglob) throw new CommandError(`no match: ${field.text}`);
            if (this.state.opts.nullglob) continue;
          }
          out.push(field.text);
        }
      }
    }
    return out;
  }

  /** Expansion without splitting or globbing (assignments, case subjects, [[ ]] operands). */
  async expandString(word: Word, io: Io): Promise<string> {
    const f = new Fields(false, this.ifs());
    await this.expandParts(word.parts, f, false, io, false);
    return f.out
      .map((x) => x.text)
      .concat(f.cur.text)
      .join(' ');
  }

  /** Expansion to a pattern: quoted characters are escaped so they match literally. */
  async expandPattern(word: Word, io: Io): Promise<string> {
    const f = new Fields(false, this.ifs());
    await this.expandParts(this.tildeExpand(word.parts), f, false, io, false);
    return f.out
      .map((x) => x.pattern)
      .concat(f.cur.pattern)
      .join(' ');
  }

  private async expandAssignment(word: Word, io: Io): Promise<string> {
    return this.expandString({ parts: this.tildeExpand(word.parts, true) }, io);
  }

  /** Expands a redirection target: one field, globbed only if it yields exactly one match. */
  private async expandRedirectTarget(word: Word, io: Io): Promise<string> {
    const fields = await this.expandWords([word], io);
    if (fields.length !== 1) {
      const raw = await this.expandString(word, io);
      throw new CommandError(`${raw}: ambiguous redirect`);
    }
    return fields[0]!;
  }

  private tildeExpand(parts: WordPart[], assignment = false): WordPart[] {
    const first = parts[0];
    if (!first || first.t !== 'lit') return parts;
    const expandOne = (text: string): string | null => {
      const user = text.slice(1);
      let home: string | undefined;
      if (user === '') home = this.state.vars.get('HOME')?.value ?? '/home/user';
      else if (user === '+') home = this.state.cwd;
      else if (user === '-') home = this.state.vars.get('OLDPWD')?.value;
      else if (user === 'root') home = '/root';
      else if (user === (this.state.vars.get('USER')?.value ?? 'user')) home = `/home/${user}`;
      return home === undefined ? null : home;
    };
    const out = [...parts];
    if (first.v.startsWith('~')) {
      const slash = first.v.indexOf('/');
      const prefixEnd = slash < 0 ? first.v.length : slash;
      // A tilde prefix followed by a quoted part (~"x") is not expanded.
      if (slash >= 0 || parts.length === 1) {
        const home = expandOne(first.v.slice(0, prefixEnd));
        if (home !== null) {
          out[0] = { t: 'sq', v: home };
          const rest = first.v.slice(prefixEnd);
          if (rest) out.splice(1, 0, { t: 'lit', v: rest });
        }
      }
    }
    if (assignment) {
      // PATH=~/bin:~/x — expand after each unquoted colon too.
      for (let i = 0; i < out.length; i++) {
        const p = out[i]!;
        if (p.t !== 'lit' || !p.v.includes(':~')) continue;
        const v = p.v.replace(/:~([^:/]*)/g, (m, user: string) => {
          const home = expandOne(`~${user}`);
          return home === null ? m : `:${home}`;
        });
        out[i] = { t: 'lit', v };
      }
    }
    return out;
  }

  private async expandParts(
    parts: readonly WordPart[],
    f: Fields,
    quoted: boolean,
    io: Io,
    litIsExpansion: boolean,
  ): Promise<void> {
    for (const part of parts) {
      switch (part.t) {
        case 'lit':
          if (quoted) f.quoted(part.v);
          else if (litIsExpansion) f.expansion(part.v);
          else f.literal(part.v);
          break;
        case 'sq':
          f.quoted(part.v);
          break;
        case 'dq': {
          const only = part.parts.length === 1 ? part.parts[0] : undefined;
          if (only?.t === 'param' && only.name === '@' && !only.op && !only.length) {
            this.expandAt(f, true);
            break;
          }
          f.quoted('');
          await this.expandParts(part.parts, f, true, io, false);
          break;
        }
        case 'param':
          await this.expandParam(part, f, quoted, io);
          break;
        case 'cmd': {
          const out = await this.commandSubst(part.body, io);
          if (quoted) f.quoted(out);
          else f.expansion(out);
          break;
        }
        case 'arith': {
          let v: bigint;
          try {
            v = await this.arith(part.expr, io);
          } catch (err) {
            if (err instanceof ArithError) throw new CommandError(err.message, 1, true);
            throw err;
          }
          if (quoted) f.quoted(String(v));
          else f.expansion(String(v));
          break;
        }
        case 'procsub': {
          f.quoted(await this.processSubst(part.body, io));
          break;
        }
      }
    }
  }

  private expandAt(f: Fields, quoted: boolean, list = this.state.positional): void {
    list.forEach((arg, i) => {
      if (i > 0) {
        if (quoted || f.split) f.push();
        else f.literal(' ');
      }
      if (quoted) f.quoted(arg);
      else f.expansion(arg);
    });
  }

  private async expandParam(part: ParamPart, f: Fields, quoted: boolean, io: Io): Promise<void> {
    const name = part.name;
    const isList = name === '@' || name === '*';
    if (part.length) {
      const v = isList
        ? String(this.state.positional.length)
        : String([...(this.lookup(name) ?? '')].length);
      if (quoted) f.quoted(v);
      else f.expansion(v);
      return;
    }
    let value: string | undefined;
    if (part.indirect) {
      const target = this.lookup(name) ?? '';
      value = NAME_RE.test(target) || /^[0-9]+$/.test(target) ? this.getParam(target) : undefined;
    } else {
      value = isList
        ? this.state.positional.length > 0
          ? this.getParam(name)
          : undefined
        : this.getParam(name);
    }
    const op = part.op;
    const emit = (v: string) => (quoted ? f.quoted(v) : f.expansion(v));
    const emitValue = () => {
      if (isList && !part.indirect) {
        if (name === '@' || !quoted) this.expandAt(f, quoted);
        else emit(this.state.positional.join(this.ifs()[0] ?? ''));
      } else emit(value ?? '');
    };

    if (!op) {
      if (value === undefined && this.state.opts.nounset && !isList) {
        throw new CommandError(
          `${/^[0-9]+$/.test(name) ? '$' : ''}${name}: unbound variable`,
          127,
          true,
        );
      }
      emitValue();
      return;
    }
    switch (op.k) {
      case 'default':
      case 'assign':
      case 'error':
      case 'alt': {
        const unset = value === undefined || (op.colon && value === '');
        if (op.k === 'alt') {
          if (!unset) await this.expandParts(op.word.parts, f, quoted, io, !quoted);
          else if (quoted) f.quoted('');
          return;
        }
        if (!unset) {
          emitValue();
          return;
        }
        if (op.k === 'default') {
          await this.expandParts(this.tildeExpand(op.word.parts), f, quoted, io, !quoted);
          return;
        }
        const word = await this.expandString(op.word, io);
        if (op.k === 'assign') {
          if (!NAME_RE.test(name))
            throw new CommandError(`$${name}: cannot assign in this way`, 1, true);
          const err = this.setVar(name, word);
          if (err) throw new CommandError(err, 1, true);
          emit(word);
          return;
        }
        throw new CommandError(`${name}: ${word || 'parameter null or not set'}`, 127, true);
      }
      case 'trim': {
        const pat = await this.expandPattern(op.pattern, io);
        if (isList) {
          const list = this.state.positional.map((a) => trimPattern(a, pat, op.from, op.longest));
          this.emitList(f, quoted, name, list);
          return;
        }
        this.checkUnset(name, value);
        emit(trimPattern(value ?? '', pat, op.from, op.longest));
        return;
      }
      case 'replace': {
        const pat = await this.expandPattern(op.pattern, io);
        const rep = op.replacement ? await this.expandString(op.replacement, io) : '';
        const apply = (s: string) => replacePattern(s, pat, rep, op.all, op.anchor);
        if (isList) {
          this.emitList(f, quoted, name, this.state.positional.map(apply));
          return;
        }
        this.checkUnset(name, value);
        emit(apply(value ?? ''));
        return;
      }
      case 'substr': {
        const offset = Number(await this.arith(op.offset, io));
        const length = op.length ? Number(await this.arith(op.length, io)) : null;
        if (isList) {
          // ${@:1} counts $0 as index 0.
          const all = [this.state.arg0, ...this.state.positional];
          const start = offset < 0 ? Math.max(all.length + offset, 0) : offset;
          let slice = all.slice(start);
          if (length !== null)
            slice =
              length < 0
                ? slice.slice(0, Math.max(slice.length + length, 0))
                : slice.slice(0, length);
          this.emitList(f, quoted, name, slice);
          return;
        }
        this.checkUnset(name, value);
        const chars = [...(value ?? '')];
        let start = offset < 0 ? chars.length + offset : offset;
        if (start < 0 || start > chars.length) {
          emit('');
          return;
        }
        let end = chars.length;
        if (length !== null) {
          end = length < 0 ? chars.length + length : Math.min(start + length, chars.length);
          if (end < start) throw new CommandError(`${length}: substring expression < 0`, 1, true);
        }
        start = Math.max(start, 0);
        emit(chars.slice(start, end).join(''));
        return;
      }
      case 'case': {
        const conv = (s: string) => {
          if (op.all) return op.upper ? s.toUpperCase() : s.toLowerCase();
          const first = s.slice(0, 1);
          return (op.upper ? first.toUpperCase() : first.toLowerCase()) + s.slice(1);
        };
        if (isList) {
          this.emitList(f, quoted, name, this.state.positional.map(conv));
          return;
        }
        this.checkUnset(name, value);
        emit(conv(value ?? ''));
        return;
      }
    }
  }

  private emitList(f: Fields, quoted: boolean, name: string, list: string[]): void {
    if (name === '@' || !quoted) this.expandAt(f, quoted, list);
    else f.quoted(list.join(this.ifs()[0] ?? ''));
  }

  private checkUnset(name: string, value: string | undefined): void {
    if (value === undefined && this.state.opts.nounset)
      throw new CommandError(
        `${/^[0-9]+$/.test(name) ? '$' : ''}${name}: unbound variable`,
        127,
        true,
      );
  }

  private lookup(name: string): string | undefined {
    return this.getParam(name);
  }

  /** Runs a command substitution and returns its output without trailing newlines. */
  private async commandSubst(body: List, io: Io): Promise<string> {
    const sink = new CollectSink();
    const sub = this.subshell();
    sub.state.opts.errexit = false;
    const subIo = io.with(1, { w: sink });
    let status: number;
    try {
      status = await sub.exitWith(await sub.runList(body, subIo), subIo);
    } catch (err) {
      status = await sub.exitWith(await sub.topLevelStatus(err, subIo), subIo);
    }
    this.substStatus = status;
    this.state.status = status;
    return sink.text().replace(/\n+$/, '');
  }

  private async processSubst(body: List, io: Io): Promise<string> {
    const sink = new CollectSink();
    const sub = this.subshell();
    const subIo = io.with(1, { w: sink });
    try {
      await sub.runList(body, subIo);
    } catch (err) {
      await sub.topLevelStatus(err, subIo);
    }
    const path = this.tempPath('procsub');
    this.fs.writeFileSync(path, sink.bytes());
    this.tempFiles.push(path);
    return path;
  }

  tempPath(kind: string): string {
    const dir = this.state.vars.get('TMPDIR')?.value || '/tmp';
    try {
      this.fs.mkdirSync(dir, { recursive: true });
    } catch {
      // reported when the file is written
    }
    return `${dir}/.sh-${kind}-${this.host.pid}-${Shell.nextTemp++}`;
  }

  private removeTemp(path: string): void {
    try {
      this.fs.unlinkSync(path);
    } catch {
      // already gone
    }
  }

  private cleanupTemp(): void {
    for (const f of this.tempFiles) this.removeTemp(f);
    this.tempFiles = [];
  }

  // ------------------------------------------------------------------- glob

  glob(pattern: string): string[] {
    const absolute = pattern.startsWith('/');
    const segments = pattern.split('/').filter((s, i, a) => s !== '' || i === a.length - 1);
    const trailingSlash = pattern.endsWith('/') && pattern.length > 1;
    if (trailingSlash) segments.pop();
    let candidates: string[] = [absolute ? '/' : ''];
    const dotglob = this.state.opts.dotglob;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const last = i === segments.length - 1;
      const next: string[] = [];
      if (!hasGlob(seg)) {
        const lit = unescapePattern(seg);
        for (const c of candidates) next.push(c + lit + (last ? '' : '/'));
      } else {
        const re = new RegExp(`^(?:${patternToRegex(seg)})$`);
        const explicitDot = seg.startsWith('.') || seg.startsWith('\\.');
        for (const c of candidates) {
          const dir = resolvePath(this.state.cwd, c === '' ? '.' : c);
          let names: string[];
          try {
            names = this.fs.readdirSync(dir) as string[];
          } catch {
            continue;
          }
          const matched = names
            .filter((n) =>
              n.startsWith('.') ? (explicitDot || dotglob) && n !== '.' && n !== '..' : true,
            )
            .filter((n) => re.test(n))
            .sort(compareBytes);
          for (const n of matched) next.push(c + n + (last ? '' : '/'));
        }
      }
      candidates = next;
      if (candidates.length === 0) return [];
    }
    const out: string[] = [];
    for (const c of candidates) {
      const full = resolvePath(this.state.cwd, c === '' ? '.' : c);
      try {
        const st = trailingSlash ? this.fs.statSync(full) : this.fs.lstatSync(full);
        if (trailingSlash && !st.isDirectory()) continue;
        out.push(trailingSlash ? `${c}/` : c);
      } catch {
        // literal segment that does not exist
      }
    }
    return out;
  }

  // -------------------------------------------------------------- redirects

  /** Applies redirections on top of `io`. The cleanup closes opened files. */
  async redirect(redirects: readonly Redirect[], io: Io): Promise<{ io: Io; cleanup: () => void }> {
    if (redirects.length === 0) return { io, cleanup: () => {} };
    const out = io.clone();
    const opened: (() => void)[] = [];
    const cleanup = () => {
      for (const c of opened.splice(0)) {
        try {
          c();
        } catch {
          // closing twice is harmless
        }
      }
    };
    try {
      for (const r of redirects) await this.applyRedirect(r, out, opened);
    } catch (err) {
      cleanup();
      throw err;
    }
    return { io: out, cleanup };
  }

  private async applyRedirect(r: Redirect, io: Io, opened: (() => void)[]): Promise<void> {
    const op = r.op;
    if (op === '<<' || op === '<<-') {
      const text = await this.expandString(r.heredoc ?? { parts: [] }, io);
      io.fds.set(r.fd ?? 0, { r: bytesSource(text) });
      return;
    }
    if (op === '<<<') {
      const text = await this.expandString(r.target, io);
      io.fds.set(r.fd ?? 0, { r: bytesSource(`${text}\n`) });
      return;
    }
    const target = await this.expandRedirectTarget(r.target, io);
    if (op === '>&' || op === '<&') {
      const fd = r.fd ?? (op === '>&' ? 1 : 0);
      if (target === '-') {
        io.fds.delete(fd);
        return;
      }
      if (/^[0-9]+-?$/.test(target)) {
        const src = Number(target.replace('-', ''));
        const entry = io.fds.get(src);
        if (!entry) throw new CommandError(`${src}: Bad file descriptor`);
        io.fds.set(fd, { ...entry });
        if (target.endsWith('-')) io.fds.delete(src);
        return;
      }
      if (op === '<&') throw new CommandError(`${target}: ambiguous redirect`);
      // `>&file` means `&>file`.
      if (r.fd === null) {
        const sink = this.openSink(target, false, opened);
        io.fds.set(1, { w: sink });
        io.fds.set(2, { w: sink });
        return;
      }
      throw new CommandError(`${target}: ambiguous redirect`);
    }
    if (op === '&>' || op === '&>>') {
      const sink = this.openSink(target, op === '&>>', opened);
      io.fds.set(1, { w: sink });
      io.fds.set(2, { w: sink });
      return;
    }
    if (op === '<') {
      io.fds.set(r.fd ?? 0, { r: this.openSource(target, opened, io) });
      return;
    }
    if (op === '<>') {
      const path = resolvePath(this.state.cwd, target);
      try {
        const fd = this.fs.openSync(path, 'a+');
        this.fs.closeSync(fd);
      } catch (err) {
        throw new CommandError(`${target}: ${strerror(err)}`);
      }
      io.fds.set(r.fd ?? 0, { r: this.openSource(target, opened, io) });
      return;
    }
    // > >> >|
    const sink = this.openSink(target, op === '>>', opened, op === '>|', io);
    io.fds.set(r.fd ?? 1, { w: sink });
  }

  private specialSink(path: string, io?: Io): Sink | null {
    switch (path) {
      case '/dev/null':
        return { write() {} };
      case '/dev/stdout':
      case '/dev/fd/1':
        return io?.stdout ?? null;
      case '/dev/stderr':
      case '/dev/fd/2':
        return io?.stderr ?? null;
      case '/dev/tty':
        return io?.stderr ?? null;
    }
    return null;
  }

  openSink(
    target: string,
    append: boolean,
    opened: (() => void)[],
    clobber = false,
    io?: Io,
  ): Sink {
    const path = resolvePath(this.state.cwd, target);
    const special = this.specialSink(path, io);
    if (special) return special;
    if (this.state.opts.noclobber && !append && !clobber) {
      try {
        if (this.fs.statSync(path).isFile())
          throw new CommandError(`${target}: cannot overwrite existing file`);
      } catch (err) {
        if (err instanceof CommandError) throw err;
      }
    }
    let fd: number;
    try {
      fd = this.fs.openSync(path, append ? 'a' : 'w');
    } catch (err) {
      throw new CommandError(`${target}: ${strerror(err)}`);
    }
    const fs = this.fs;
    let closed = false;
    opened.push(() => {
      if (!closed) fs.closeSync(fd);
      closed = true;
    });
    return {
      write(data) {
        if (closed) throw new CommandError(`write error: Bad file descriptor`);
        fs.writeSync(fd, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      },
    };
  }

  openSource(target: string, opened: (() => void)[], io?: Io): Source {
    const path = resolvePath(this.state.cwd, target);
    if (path === '/dev/null') return emptySource();
    if ((path === '/dev/stdin' || path === '/dev/fd/0') && io) return io.stdin;
    let src: Source;
    try {
      if (this.fs.statSync(path).isDirectory()) {
        // bash opens directories fine; reads then fail. Model as empty with an error on read.
        return new BufferedSource(() => {
          throw new CommandError(`read error: 0: Is a directory`);
        });
      }
      src = fileSource(this.fs, path);
    } catch (err) {
      if (err instanceof CommandError) throw err;
      throw new CommandError(`${target}: ${strerror(err)}`);
    }
    opened.push(() => src.close());
    return src;
  }

  // ------------------------------------------------------------------- jobs

  async waitAll(): Promise<number> {
    let status = 0;
    for (const job of [...this.jobs.values()]) {
      status = await job.done;
      this.jobs.delete(job.pid);
    }
    return status;
  }

  async waitFor(pid: number): Promise<number | null> {
    const job = this.jobs.get(pid);
    if (!job) return null;
    const status = await job.done;
    this.jobs.delete(pid);
    return status;
  }

  async waitAny(): Promise<number | null> {
    const pending = [...this.jobs.values()];
    if (pending.length === 0) return null;
    const job = await Promise.race(pending.map((j) => j.done.then(() => j)));
    this.jobs.delete(job.pid);
    return job.status ?? 0;
  }

  jobList(): Job[] {
    return [...this.jobs.values()];
  }

  /** Runs a file of shell code in this shell (`.` / `source`). */
  async source(path: string, args: string[] | null, io: Io): Promise<number> {
    const text = new TextDecoder().decode(this.fs.readFileSync(path));
    const savedArgs = this.state.positional;
    if (args) this.state.positional = args;
    this.sourceDepth++;
    const savedName = this.scriptName;
    try {
      let list: List;
      try {
        list = parse(text);
      } catch (err) {
        if (err instanceof ParseError) {
          await io.stderr.write(`${path}: line ${err.line}: ${err.message}\n`);
          return 2;
        }
        throw err;
      }
      return await this.runList(list, io);
    } catch (err) {
      if (err instanceof ReturnSignal) return err.status;
      throw err;
    } finally {
      this.sourceDepth--;
      this.scriptName = savedName;
      if (args) this.state.positional = savedArgs;
    }
  }
}

/** Runs an in-process command, mapping EPIPE to 141 and stray errors to 1. */
export async function runCommandFn(fn: CommandFn, ctx: CommandContext): Promise<number> {
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof BrokenPipe) return SIGPIPE_STATUS;
    const message = err instanceof Error ? err.message : String(err);
    try {
      await ctx.stderr.write(`${ctx.argv[0]}: ${message}\n`);
    } catch {
      // stderr itself is gone
    }
    return err instanceof CommandError ? err.status : 1;
  }
}

// ------------------------------------------------------------------ helpers

let yieldCounter = 0;
/** Lets other in-process jobs run during long loops. */
function yieldToEventLoop(): Promise<void> | void {
  if (++yieldCounter % 64 !== 0) return;
  return macrotask();
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareInts(op: string, a: bigint, b: bigint): boolean {
  switch (op) {
    case '-eq':
      return a === b;
    case '-ne':
      return a !== b;
    case '-lt':
      return a < b;
    case '-le':
      return a <= b;
    case '-gt':
      return a > b;
    default:
      return a >= b;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Converts a POSIX ERE (as bash's =~ uses) to a JS regex source. */
export function eregToJs(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      out += c + (src[i + 1] ?? '');
      i++;
    } else if (c === '[') {
      const b = bracketToRegex(src, i);
      if (b) {
        out += b.re;
        i = b.end - 1;
      } else out += '\\[';
    } else out += c;
  }
  return out;
}

/** Quotes a word for `set -x` output the way bash does. */
export function traceQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------- brace expansion

type BraceTok = string | WordPart;

/** bash brace expansion over a word's unquoted text: a{b,c}d, {1..5}, {a..e..2}. */
export function braceExpand(word: Word): Word[] {
  const toks: BraceTok[] = [];
  let any = false;
  for (const p of word.parts) {
    if (p.t === 'lit') {
      for (const ch of p.v) toks.push(ch);
      if (p.v.includes('{')) any = true;
    } else toks.push(p);
  }
  if (!any) return [word];
  return expandToks(toks, 0).map((t) => ({ parts: mergeToks(t) }));
}

function expandToks(toks: BraceTok[], depth: number): BraceTok[][] {
  if (depth > 20) return [toks];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== '{') continue;
    // `${` belongs to parameter expansion (already parsed), so any `{` here is literal text.
    let level = 0;
    const commas: number[] = [];
    let close = -1;
    for (let j = i; j < toks.length; j++) {
      const t = toks[j];
      if (t === '{') level++;
      else if (t === '}') {
        level--;
        if (level === 0) {
          close = j;
          break;
        }
      } else if (t === ',' && level === 1) commas.push(j);
    }
    if (close < 0) return [toks];
    const prefix = toks.slice(0, i);
    const suffix = toks.slice(close + 1);
    if (commas.length > 0) {
      const alts: BraceTok[][] = [];
      let start = i + 1;
      for (const c of [...commas, close]) {
        alts.push(toks.slice(start, c));
        start = c + 1;
      }
      const out: BraceTok[][] = [];
      for (const alt of alts) {
        for (const expandedAlt of expandToks(alt, depth + 1)) {
          out.push(...expandToks([...prefix, ...expandedAlt, ...suffix], depth + 1));
        }
      }
      return out;
    }
    const inner = toks.slice(i + 1, close);
    if (inner.every((t) => typeof t === 'string')) {
      const seq = sequence(inner.join(''));
      if (seq) {
        const out: BraceTok[][] = [];
        for (const s of seq)
          out.push(...expandToks([...prefix, ...s.split(''), ...suffix], depth + 1));
        return out;
      }
    }
    // Not a valid brace expression: keep `{` literal and continue after it.
    const rest = expandToks(toks.slice(i + 1), depth + 1);
    return rest.map((r) => [...toks.slice(0, i + 1), ...r]);
  }
  return [toks];
}

function sequence(text: string): string[] | null {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let step = Math.abs(Number(m[3] ?? 1)) || 1;
    const width =
      /^-?0\d/.test(m[1]!) || /^-?0\d/.test(m[2]!) ? Math.max(m[1]!.length, m[2]!.length) : 0;
    const out: string[] = [];
    if (a > b) step = -step;
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) {
      let s = String(Math.abs(n)).padStart(width - (n < 0 ? 1 : 0), '0');
      if (n < 0) s = `-${s}`;
      out.push(s);
      if (out.length > 100000) break;
    }
    return out;
  }
  m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text);
  if (m) {
    const a = m[1]!.charCodeAt(0);
    const b = m[2]!.charCodeAt(0);
    let step = Math.abs(Number(m[3] ?? 1)) || 1;
    if (a > b) step = -step;
    const out: string[] = [];
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(String.fromCharCode(n));
    return out;
  }
  return null;
}

function mergeToks(toks: BraceTok[]): WordPart[] {
  const parts: WordPart[] = [];
  let lit = '';
  for (const t of toks) {
    if (typeof t === 'string') lit += t;
    else {
      if (lit) parts.push({ t: 'lit', v: lit });
      lit = '';
      parts.push(t);
    }
  }
  if (lit) parts.push({ t: 'lit', v: lit });
  return parts;
}

export { parse, parseExpandable };
