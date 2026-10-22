// SPDX-License-Identifier: Apache-2.0
// A pseudo-terminal's line discipline (ADR 0017): what Linux's n_tty does
// between a terminal emulator and the programs running on it. In cooked mode
// it echoes typed characters, edits the line (erase, kill, word erase), turns
// Ctrl+C / Ctrl+\ into signals and Ctrl+D into end-of-file, and hands over
// whole lines. In raw mode (`setRawMode(true)`) bytes pass straight through.
// Output gets ONLCR: every \n becomes \r\n.

import { encodeUtf8 } from '@clientvm/protocol';
import type { Signal, WindowSize } from '@clientvm/protocol';

export interface PtyHooks {
  /** Bytes for the terminal display: program output and echo. */
  output(data: Uint8Array): void;
  /** Input for the foreground reader: a line, raw bytes, or an empty chunk for end-of-file. */
  deliver(data: Uint8Array): void;
  /** A signal for the terminal's foreground process group. */
  signal(signal: Signal): void;
}

/** Longest line cooked mode keeps (Linux's N_TTY_BUF_SIZE); more input is dropped. */
const MAX_LINE = 4096;

const INTR = '\x03';
const QUIT = '\x1c';
const SUSP = '\x1a';
const EOF = '\x04';
const ERASE = '\x7f';
const ERASE_BS = '\x08';
const KILL = '\x15';
const WERASE = '\x17';

/** How echo shows a control character (ECHOCTL): `^C`, `^[`. */
const caret = (c: string) => `^${String.fromCharCode(c.charCodeAt(0) ^ 0x40)}`;
const isControl = (c: string) => c.length === 1 && (c < ' ' || c === '\x7f');
/** Columns a character took when echoed. */
const echoWidth = (c: string) => (c === '\t' ? 1 : isControl(c) ? 2 : 1);

export class Pty {
  size: WindowSize;
  /** Raw mode: no echo, no line editing, no signal keys. */
  raw = false;
  private readonly hooks: PtyHooks;
  /** The cooked-mode line being typed, one entry per character. */
  private line: string[] = [];
  private readonly decoder = new TextDecoder();

  constructor(size: WindowSize, hooks: PtyHooks) {
    this.size = { ...size };
    this.hooks = hooks;
  }

  /** Keyboard input from the terminal emulator. */
  input(data: Uint8Array): void {
    if (this.raw) {
      if (data.length > 0) this.hooks.deliver(data);
      return;
    }
    let echo = '';
    const flushEcho = () => {
      if (echo) this.hooks.output(encodeUtf8(echo));
      echo = '';
    };
    for (const ch of this.decoder.decode(data, { stream: true })) {
      // ICRNL: Enter sends \r; programs read \n.
      const c = ch === '\r' ? '\n' : ch;
      if (c === INTR || c === QUIT || c === SUSP) {
        echo += `${caret(c)}\r\n`;
        flushEcho();
        this.line = [];
        this.hooks.signal(c === INTR ? 'SIGINT' : c === QUIT ? 'SIGQUIT' : 'SIGTSTP');
      } else if (c === '\n') {
        echo += '\r\n';
        flushEcho();
        this.line.push('\n');
        this.submit();
      } else if (c === EOF) {
        // Ends the read: an empty line is end-of-file; otherwise the line goes as typed.
        flushEcho();
        this.submit();
      } else if (c === ERASE || c === ERASE_BS) {
        const last = this.line.pop();
        if (last !== undefined) echo += '\b \b'.repeat(echoWidth(last));
      } else if (c === KILL) {
        for (const erased of this.line.splice(0)) echo += '\b \b'.repeat(echoWidth(erased));
      } else if (c === WERASE) {
        while (this.line.length > 0 && /\s/.test(this.line.at(-1)!))
          echo += '\b \b'.repeat(echoWidth(this.line.pop()!));
        while (this.line.length > 0 && !/\s/.test(this.line.at(-1)!))
          echo += '\b \b'.repeat(echoWidth(this.line.pop()!));
      } else if (this.line.length < MAX_LINE) {
        this.line.push(c);
        echo += isControl(c) && c !== '\t' ? caret(c) : c;
      }
    }
    flushEcho();
  }

  /** Output from a program on this terminal. */
  write(data: Uint8Array): void {
    if (data.length === 0) return;
    let lf = 0;
    for (const b of data) if (b === 0x0a) lf++;
    if (lf === 0) {
      this.hooks.output(data);
      return;
    }
    const out = new Uint8Array(data.length + lf);
    let j = 0;
    for (const b of data) {
      if (b === 0x0a) out[j++] = 0x0d;
      out[j++] = b;
    }
    this.hooks.output(out);
  }

  /** `setRawMode`. Leaving raw mode starts a fresh line. */
  setRaw(raw: boolean): void {
    if (raw === this.raw) return;
    this.raw = raw;
    this.line = [];
  }

  /** Changes the size. Returns whether it changed (the caller then sends SIGWINCH). */
  resize(size: WindowSize): boolean {
    if (size.cols === this.size.cols && size.rows === this.size.rows) return false;
    this.size = { ...size };
    return true;
  }

  private submit(): void {
    const text = this.line.join('');
    this.line = [];
    this.hooks.deliver(encodeUtf8(text));
  }
}
