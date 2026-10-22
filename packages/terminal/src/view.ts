// SPDX-License-Identifier: Apache-2.0
import type { Disposable, Instance, ProcessEvent, ProcessInfo } from '@clientvm/clientvm';
import { displayCommand } from './command.ts';
import { createSanitizer } from './sanitize.ts';

/**
 * The part of a terminal emulator the view writes to. An xterm.js `Terminal`
 * fits as is; nothing else of it is used, so this package does not depend on it.
 */
export interface TerminalLike {
  write(data: string): void;
}

export interface ActivityViewOptions {
  /** Which processes to show, e.g. `(p) => p.tag?.source === 'agent'`. Default: all. */
  filter?: (process: ProcessInfo) => boolean;
  /** Text put before a command's `$` line, e.g. `🤖 ` for agent commands. Written as is. */
  label?: (process: ProcessInfo) => string | undefined;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/** `1.2 s`, `350 ms`, `3m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** A command line made safe to draw: no control characters, newlines continued with `> `. */
function commandText(command: string): string {
  return (
    command
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
      .replace(/\n/g, `\r\n${DIM}>${RESET} `)
  );
}

/**
 * Writes the commands an instance runs to a terminal as they happen: a `$`
 * line per command, its output, and a line with its exit status and run
 * time. Output from concurrent processes is labelled when it switches
 * between them. Escape sequences that could reach outside the terminal
 * (clipboard, links) are removed. Recent history is replayed first.
 */
export function attachActivityView(
  term: TerminalLike,
  instance: Pick<Instance, 'onProcess'>,
  opts: ActivityViewOptions = {},
): Disposable {
  const shown = new Map<
    number,
    {
      command: string;
      startedAt: number;
      decoders: { 1: TextDecoder; 2: TextDecoder };
      sanitize: { 1: (s: string) => string; 2: (s: string) => string };
    }
  >();
  /** Process whose output was written last, so a switch can be labelled. */
  let current: number | null = null;
  let atLineStart = true;

  const write = (text: string) => {
    if (!text) return;
    // Output is not from a TTY, so lines end in a bare \n; a terminal also needs \r.
    term.write(text.replace(/(?<!\r)\n/g, '\r\n'));
    atLineStart = text.endsWith('\n');
  };
  const line = (text: string) => {
    term.write(`${atLineStart ? '' : '\r\n'}${text}\r\n`);
    atLineStart = true;
  };

  const onEvent = (e: ProcessEvent) => {
    if (e.type === 'spawn') {
      const p = e.process;
      if (opts.filter && !opts.filter(p)) return;
      const command = commandText(displayCommand(p.argv));
      shown.set(p.pid, {
        command,
        startedAt: p.startedAt,
        decoders: { 1: new TextDecoder(), 2: new TextDecoder() },
        sanitize: { 1: createSanitizer(), 2: createSanitizer() },
      });
      line(`${opts.label?.(p) ?? ''}${BOLD}${CYAN}$${RESET} ${BOLD}${command}${RESET}`);
      current = p.pid;
      return;
    }
    const proc = shown.get(e.pid);
    if (!proc) return;
    if (e.type === 'output') {
      const text = proc.sanitize[e.fd](proc.decoders[e.fd].decode(e.data, { stream: true }));
      if (!text) return;
      if (current !== e.pid) {
        line(`${DIM}[${proc.command}]${RESET}`);
        current = e.pid;
      }
      write(text);
      return;
    }
    shown.delete(e.pid);
    write(
      proc.sanitize[1](proc.decoders[1].decode()) + proc.sanitize[2](proc.decoders[2].decode()),
    );
    const ok = e.code === 0 && !e.signal;
    const status = ok ? `${GREEN}✔${RESET}` : `${RED}✖ ${e.signal ?? `exit ${e.code}`}${RESET}`;
    const which = current === e.pid ? '' : `${proc.command} · `;
    line(`${status} ${DIM}${which}${formatDuration(e.exitedAt - proc.startedAt)}${RESET}`);
    current = null;
  };

  return instance.onProcess(onEvent);
}
