// SPDX-License-Identifier: Apache-2.0
// The interactive shell (ADR 0017): `bash -i`, or `sh`/`bash` with no script
// when stdin and stderr are a terminal. A prompt (PS1/PS2), line editing in
// raw mode with history (~/.bash_history) and Tab completion, Ctrl+C that
// interrupts the running line without ending the shell, and background jobs
// that are announced when they finish.

import { LineEditor, parseKeys } from '@clientvm/node-compat';
import type { ProcessContext, Tty } from '@clientvm/process';
import { encodeUtf8 } from '@clientvm/protocol';
import { BUILTINS } from './builtins.ts';
import { BufferedSource } from './io.ts';
import type { Sink, Source } from './io.ts';
import { ParseError, parse } from './parser.ts';
import { Interrupted } from './shell.ts';
import type { Io, Shell } from './shell.ts';

/** Ubuntu's default bash prompt, in colour. */
const DEFAULT_PS1 = '\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ ';
const HISTORY_LINES = 1000;

/**
 * The terminal's input, shared by the line editor and the commands it runs.
 * Readers can be cancelled, so a command abandoned by Ctrl+C stops consuming
 * keystrokes meant for the next prompt.
 */
class TerminalInput {
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: ((data: Uint8Array | null) => void)[] = [];
  private closed = false;

  constructor(ctx: ProcessContext) {
    ctx.stdin.subscribe((data) => {
      if (data === null) {
        this.closed = true;
        for (const w of this.waiters.splice(0)) w(null);
        return;
      }
      const w = this.waiters.shift();
      if (w) w(data);
      else this.queue.push(data);
    });
  }

  /** The next chunk: null when the terminal hung up or `signal` aborted; empty for Ctrl+D. */
  read(signal?: AbortSignal): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      };
      const waiter = (data: Uint8Array | null) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(data);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Puts input back for the next reader (keys typed after a line that was submitted). */
  unshift(data: Uint8Array): void {
    if (data.length > 0) this.queue.unshift(data);
  }

  /** stdin for one command line: ends at Ctrl+D, a hang-up, or when the line is interrupted. */
  source(signal: AbortSignal): Source {
    return new BufferedSource(
      async () => {
        const data = await this.read(signal);
        return data === null || data.length === 0 ? null : data;
      },
      undefined,
      true,
    );
  }
}

/** Expands bash prompt escapes (`\u`, `\h`, `\w`, `\$`, `\[`...). */
export function expandPrompt(
  ps: string,
  shell: Shell,
  jobs: number,
  historyNumber: number,
): string {
  const home = shell.getVar('HOME') ?? '';
  const cwd = shell.state.cwd;
  const short =
    home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return ps.replace(/\\(0[0-7]{2}|[\s\S])/g, (_, c: string) => {
    if (c.length === 3) return String.fromCharCode(parseInt(c, 8));
    switch (c) {
      case 'u':
        return shell.getVar('USER') ?? 'user';
      case 'h':
      case 'H':
        return shell.getVar('HOSTNAME') ?? 'clientvm';
      case 'w':
        return short;
      case 'W':
        return cwd === home ? '~' : cwd === '/' ? '/' : (cwd.split('/').pop() ?? cwd);
      case '$':
        return '$';
      case 's':
        return shell.state.arg0.replace(/^.*\//, '');
      case 'v':
        return '5.2';
      case 'V':
        return '5.2.21';
      case 'j':
        return String(jobs);
      case '!':
      case '#':
        return String(historyNumber);
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case 'a':
        return '\x07';
      case 't':
        return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
      case 'T':
        return `${two(now.getHours() % 12 || 12)}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
      case 'A':
        return `${two(now.getHours())}:${two(now.getMinutes())}`;
      case 'd':
        return now.toDateString().slice(0, 10);
      case '[':
      case ']':
        // Non-printing markers; display width is measured without escape sequences anyway.
        return '';
      case '\\':
        return '\\';
      default:
        return `\\${c}`;
    }
  });
}

/** Whether `src` ends in the middle of a command (an open quote, `if` without `fi`, ...). */
function incomplete(src: string): boolean {
  try {
    parse(src);
    return false;
  } catch (err) {
    return err instanceof ParseError && err.incomplete;
  }
}

/** Quotes a completed word the way bash's completion does. */
const escapeWord = (s: string) => s.replace(/([\s'"\\$`!&|;()<>*?[\]{}#~])/g, '\\$1');

/** Runs the read-eval loop; returns the shell's exit status. */
export async function runInteractive(
  shell: Shell,
  ctx: ProcessContext,
  tty: Tty,
  ioFor: (stdin: Source) => Io,
): Promise<number> {
  shell.interactive = true;
  const input = new TerminalInput(ctx);
  const err = (text: string) => ctx.stderr.write(text);
  const fs = shell.host.fs;
  const home = shell.getVar('HOME') ?? '/home/user';
  const histFile = shell.getVar('HISTFILE') ?? `${home}/.bash_history`;

  if (shell.getVar('PS1') === undefined) shell.setVar('PS1', DEFAULT_PS1);
  if (shell.getVar('PS2') === undefined) shell.setVar('PS2', '> ');
  const setSize = () => {
    shell.setVar('COLUMNS', String(tty.size.cols));
    shell.setVar('LINES', String(tty.size.rows));
  };
  setSize();

  let history: string[] = [];
  try {
    history = new TextDecoder()
      .decode(fs.readFileSync(histFile))
      .split('\n')
      .filter((l) => l.trim())
      .slice(-HISTORY_LINES)
      .reverse();
  } catch {
    // No history yet.
  }
  const editor = new LineEditor({ history, historySize: HISTORY_LINES });
  const remember = (line: string) => {
    if (!line.trim() || line.startsWith(' ')) return;
    editor.addHistory(line);
    try {
      fs.appendFileSync(histFile, `${line}\n`);
    } catch {
      // A read-only home is not an error for the shell.
    }
  };

  // Ctrl+C reaches the shell as SIGINT while a line runs (at the prompt the
  // terminal is raw, so it arrives as a key). Like bash, the shell waits for a
  // foreground program, which gets the signal too: the line stops only if
  // the program dies of it. Work running in the shell itself stops at once.
  // Interactive shells ignore SIGTERM and SIGQUIT; SIGHUP ends them.
  let running: AbortController | null = null;
  let foregroundPrograms = 0;
  let sigintPending = false;
  const spawn = shell.host.spawn;
  shell.host.spawn = async (argv, stdio) => {
    if (stdio.background) return spawn(argv, stdio);
    foregroundPrograms++;
    try {
      const status = await spawn(argv, stdio);
      if (status === 130 && sigintPending) running?.abort();
      return status;
    } finally {
      foregroundPrograms--;
      if (foregroundPrograms === 0) sigintPending = false;
    }
  };
  ctx.onSignal((signal) => {
    switch (signal) {
      case 'SIGINT':
        if (foregroundPrograms > 0) sigintPending = true;
        else running?.abort();
        return true;
      case 'SIGWINCH':
        setSize();
        return true;
      case 'SIGTERM':
      case 'SIGQUIT':
        return true;
    }
    return false;
  });

  /** Reads one line with the editor; null at Ctrl+D on an empty line or a hang-up. */
  const readLine = async (prompt: string): Promise<string | null> => {
    tty.setRaw(true);
    editor.reset();
    let cursorRow = 0;
    let lastWasTab = false;
    const draw = () => {
      const r = editor.render(prompt, tty.size.cols, cursorRow);
      cursorRow = r.cursorRow;
      err(r.text);
    };
    draw();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await input.read();
        if (chunk === null) return null;
        const text = decoder.decode(chunk, { stream: true });
        const keys = parseKeys(text);
        // A paste arrives as one chunk: draw once after its keys, not per key.
        let dirty = false;
        for (let i = 0; i < keys.length; i++) {
          const result = editor.key(keys[i]!);
          const tab = result === 'complete';
          switch (result) {
            case 'submit': {
              if (dirty) draw();
              err('\r\n');
              // Keys after Enter (a paste of several lines) belong to whoever reads next.
              const rest = keys
                .slice(i + 1)
                .map((k) => k.sequence)
                .join('');
              input.unshift(encodeUtf8(rest));
              return editor.line;
            }
            case 'interrupt':
              err('^C\r\n');
              shell.state.status = 130;
              editor.reset();
              cursorRow = 0;
              draw();
              break;
            case 'eof':
              return null;
            case 'clear':
              err('\x1b[H\x1b[2J');
              cursorRow = 0;
              draw();
              break;
            case 'complete':
              if (complete(lastWasTab)) cursorRow = 0;
              dirty = true;
              break;
            case 'edit':
              dirty = true;
              break;
            case 'ignored':
              break;
          }
          lastWasTab = tab;
        }
        if (dirty) draw();
      }
    } finally {
      tty.setRaw(false);
    }
  };

  /** Tab: completes the word before the cursor. Returns true when it printed a list. */
  const complete = (listAll: boolean): boolean => {
    const before = editor.beforeCursor;
    const word = /(?:\\.|[^\s'"<>|;&()])*$/.exec(before)?.[0] ?? '';
    const head = before.slice(0, before.length - word.length);
    const commandPosition = /(^|[|;&(])\s*$/.test(head);
    const typed = word.replace(/\\(.)/g, '$1');
    let candidates: string[];
    if (commandPosition && !typed.includes('/')) {
      const names = new Set<string>([
        ...Object.keys(BUILTINS),
        ...shell.state.functions.keys(),
        ...shell.state.aliases.keys(),
      ]);
      for (const dir of (shell.getVar('PATH') ?? '').split(':')) {
        try {
          for (const name of fs.readdirSync(dir || '.')) names.add(name);
        } catch {
          // Missing PATH entries are skipped.
        }
      }
      candidates = [...names].filter((n) => n.startsWith(typed)).map((n) => `${n} `);
    } else {
      const slash = typed.lastIndexOf('/');
      const dirPart = typed.slice(0, slash + 1);
      const base = typed.slice(slash + 1);
      const expanded = dirPart.startsWith('~') ? home + dirPart.slice(1) : dirPart;
      const dir = expanded.startsWith('/') ? expanded : `${shell.state.cwd}/${expanded}`;
      candidates = [];
      try {
        for (const name of fs.readdirSync(dir || '/')) {
          if (!name.startsWith(base) || (name.startsWith('.') && !base.startsWith('.'))) continue;
          let isDir = false;
          try {
            isDir = fs.statSync(`${dir}/${name}`).isDirectory();
          } catch {
            // A dangling symlink completes like a file.
          }
          candidates.push(`${dirPart}${name}${isDir ? '/' : ' '}`);
        }
      } catch {
        // Not a directory: nothing to complete.
      }
    }
    candidates.sort();
    if (candidates.length === 0) return false;
    if (candidates.length === 1) {
      const only = candidates[0]!;
      const suffix = only.endsWith(' ') ? ' ' : '';
      editor.replaceBefore(Array.from(word).length, escapeWord(only.trimEnd()) + suffix);
      return false;
    }
    let common = candidates[0]!;
    for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
    common = common.trimEnd();
    if (common.length > typed.length) {
      editor.replaceBefore(Array.from(word).length, escapeWord(common));
      return false;
    }
    if (!listAll) return false;
    // Second Tab: list the choices below the line, then redraw the prompt.
    const shown = candidates.map((c) => c.trimEnd().slice(typed.lastIndexOf('/') + 1));
    const width = Math.max(...shown.map((s) => s.length)) + 2;
    const perRow = Math.max(1, Math.floor(tty.size.cols / width));
    let out = '\r\n';
    for (let i = 0; i < shown.length; i++) {
      out += shown[i]!.padEnd(width);
      if ((i + 1) % perRow === 0 || i === shown.length - 1) out += '\r\n';
    }
    err(out);
    return true;
  };

  let status = 0;
  for (;;) {
    for (const job of shell.takeFinishedJobs()) {
      const state = job.status === 0 ? 'Done' : `Exit ${job.status}`;
      err(`[${job.id}]+  ${state.padEnd(24)}${job.command}\n`);
    }
    const jobs = shell.jobList().length;
    const prompt = expandPrompt(
      shell.getVar('PS1') ?? '$ ',
      shell,
      jobs,
      editor.history.length + 1,
    );
    let src = await readLine(prompt);
    while (src !== null && incomplete(src)) {
      const more = await readLine(expandPrompt(shell.getVar('PS2') ?? '> ', shell, jobs, 0));
      if (more === null) {
        err(`${shell.scriptName}: syntax error: unexpected end of file\n`);
        src = '';
        break;
      }
      src += `\n${more}`;
    }
    if (src === null) {
      err('exit\n');
      break;
    }
    if (!src.trim()) continue;
    remember(src);

    const controller = new AbortController();
    running = controller;
    shell.interrupt = controller.signal;
    shell.currentLine = src;
    const io = ioFor(input.source(controller.signal));
    const gate = (sink: Sink): Sink => ({
      write: (data) => {
        // Output of an interrupted line stops (and stops loops that write).
        if (controller.signal.aborted) throw new Interrupted();
        return sink.write(data);
      },
      ...(sink.inherit ? { inherit: sink.inherit } : {}),
    });
    const lineIo = io.with(1, { w: gate(io.stdout) }).with(2, { w: gate(io.stderr) });
    const run = shell.runLine(src, lineIo);
    const interrupted = new Promise<'interrupted'>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve('interrupted'), { once: true }),
    );
    const result = await Promise.race([run, interrupted]);
    running = null;
    shell.interrupt = null;
    shell.currentLine = '';
    if (result === 'interrupted') {
      // The abandoned line stops at its next command or write.
      run.catch(() => {});
      status = 130;
      shell.state.status = 130;
      continue;
    }
    status = result.status;
    if (result.exit) break;
  }
  return shell.exitWith(status, ioFor(input.source(new AbortController().signal)));
}
