// SPDX-License-Identifier: Apache-2.0
// A bounded, line-oriented log of the demo's setup processes (the one-time
// preset build, npm install, the server), fed from ClientVM's process events
// and shown while the demo starts. The output comes from code running in the
// sandbox, so it is capped and only ever rendered as text.
import { stripAnsi } from '@clientvm/terminal';

export type SetupLineKind = 'cmd' | 'out' | 'err' | 'info';
export interface SetupLine {
  seq: number;
  kind: SetupLineKind;
  text: string;
}

const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;
const NOTIFY_MS = 50;

interface Stream {
  decoder: TextDecoder;
  partial: string;
  kind: SetupLineKind;
}

export class SetupLog {
  private lines: SetupLine[] = [];
  private seq = 0;
  /** Partial-line state per `pid:fd`. */
  private streams = new Map<string, Stream>();
  private listeners = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly notifyDelayMs = NOTIFY_MS) {}

  getLines = (): SetupLine[] => this.lines;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  info(text: string): void {
    this.push([{ kind: 'info', text }]);
  }

  spawn(argv: string[]): void {
    const cmd =
      argv[0] === 'sh' && argv[1] === '-c' && argv.length === 3 ? argv[2]! : argv.join(' ');
    this.push([{ kind: 'cmd', text: cmd }]);
  }

  output(pid: number, fd: 1 | 2, data: Uint8Array): void {
    const key = `${pid}:${fd}`;
    let s = this.streams.get(key);
    if (!s) {
      s = { decoder: new TextDecoder(), partial: '', kind: fd === 2 ? 'err' : 'out' };
      this.streams.set(key, s);
    }
    const kind = s.kind;
    const parts = (s.partial + stripAnsi(s.decoder.decode(data, { stream: true }))).split('\n');
    s.partial = parts.pop() ?? '';
    // A redraw (`\r`) replaces the pending line: keep only what was written last.
    const cr = s.partial.lastIndexOf('\r');
    if (cr >= 0 && cr < s.partial.length - 1) s.partial = s.partial.slice(cr + 1);
    const done = parts.map(lastRedraw).filter((l) => l.trim() !== '');
    if (done.length) this.push(done.map((text) => ({ kind, text })));
  }

  exit(pid: number, code: number): void {
    const out: Omit<SetupLine, 'seq'>[] = [];
    for (const fd of [1, 2] as const) {
      const key = `${pid}:${fd}`;
      const s = this.streams.get(key);
      if (!s) continue;
      const rest = lastRedraw(s.partial + stripAnsi(s.decoder.decode()));
      if (rest.trim()) out.push({ kind: s.kind, text: rest });
      this.streams.delete(key);
    }
    if (code !== 0) out.push({ kind: 'err', text: `exited with code ${code}` });
    if (out.length) this.push(out);
  }

  clear(): void {
    this.streams.clear();
    this.lines = [];
    this.notify();
  }

  private push(add: Omit<SetupLine, 'seq'>[]): void {
    const next = this.lines.concat(
      add.map((l) => ({ ...l, seq: ++this.seq, text: l.text.slice(0, MAX_LINE_CHARS) })),
    );
    this.lines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    this.notify();
  }

  private notify(): void {
    if (this.notifyDelayMs <= 0) {
      this.listeners.forEach((cb) => cb());
      return;
    }
    this.pending ??= setTimeout(() => {
      this.pending = null;
      this.listeners.forEach((cb) => cb());
    }, this.notifyDelayMs);
  }
}

function lastRedraw(line: string): string {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  const cr = trimmed.lastIndexOf('\r');
  return cr >= 0 ? trimmed.slice(cr + 1) : trimmed;
}
