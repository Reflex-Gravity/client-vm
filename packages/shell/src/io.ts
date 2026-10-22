// SPDX-License-Identifier: Apache-2.0
// Byte streams between in-process commands: sources with push-back (so
// `read` and the commands after it share one stdin, as with a real fd), sinks,
// and bounded pipes with EPIPE when the reader goes away.

import { encodeUtf8 } from '@clientvm/protocol';

/** Written to a pipe whose reader has closed. Commands exit 141 (SIGPIPE) on it. */
export class BrokenPipe extends Error {
  constructor() {
    super('Broken pipe');
    this.name = 'BrokenPipe';
  }
}

export const SIGPIPE_STATUS = 141;

export interface Sink {
  write(data: Uint8Array | string): void | Promise<void>;
  /**
   * When set, this sink is the process's own stdout (1) or stderr (2), so a
   * spawned child can inherit it instead of copying through the shell.
   */
  readonly inherit?: 1 | 2;
}

export interface Source {
  /**
   * When 0, this source is the process's own stdin and that is a terminal, so
   * a spawned child reads the terminal itself (foreground job) instead of
   * having input copied to it.
   */
  readonly inherit?: 0;
  /** The next chunk, or null at end of input. */
  read(): Promise<Uint8Array | null>;
  /** Pushes bytes back so the next read returns them first. */
  unshift(data: Uint8Array): void;
  /** Stops reading: writers into a pipe get EPIPE. */
  close(): void;
}

/** A source with push-back on top of a chunk producer. */
export class BufferedSource implements Source {
  readonly inherit?: 0;
  private readonly pending: Uint8Array[] = [];
  private readonly produce: () => Promise<Uint8Array | null> | Uint8Array | null;
  private readonly onClose: (() => void) | undefined;
  private ended = false;

  constructor(
    produce: () => Promise<Uint8Array | null> | Uint8Array | null,
    onClose?: () => void,
    terminal = false,
  ) {
    this.produce = produce;
    this.onClose = onClose;
    if (terminal) this.inherit = 0;
  }

  async read(): Promise<Uint8Array | null> {
    const p = this.pending.shift();
    if (p) return p;
    if (this.ended) return null;
    const chunk = await this.produce();
    if (chunk === null) this.ended = true;
    return chunk;
  }

  unshift(data: Uint8Array): void {
    if (data.length > 0) this.pending.unshift(data);
  }

  close(): void {
    this.ended = true;
    this.pending.length = 0;
    this.onClose?.();
  }
}

export function bytesSource(data: Uint8Array | string): Source {
  let done = false;
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  return new BufferedSource(() => {
    if (done) return null;
    done = true;
    return bytes.length > 0 ? bytes : null;
  });
}

export const emptySource = (): Source => bytesSource(new Uint8Array(0));

export const nullSink: Sink = { write() {} };

export class CollectSink implements Sink {
  readonly chunks: Uint8Array[] = [];
  write(data: Uint8Array | string): void {
    this.chunks.push(typeof data === 'string' ? encodeUtf8(data) : data.slice());
  }
  bytes(): Uint8Array {
    return concatBytes(this.chunks);
  }
  text(): string {
    return new TextDecoder().decode(this.bytes());
  }
}

/**
 * Resolves on a later macrotask, so message events (child output, exits) get
 * handled. Promise-only loops would otherwise starve them.
 */
export function macrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

const PIPE_CAPACITY = 64 * 1024;

/** A bounded in-memory pipe. */
export class Pipe {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private writerClosed = false;
  private readerClosed = false;
  private readerWake: (() => void) | null = null;
  private writerWakes: (() => void)[] = [];

  readonly source: Source;
  readonly sink: Sink;

  constructor() {
    this.source = new BufferedSource(
      () => this.take(),
      () => this.closeReader(),
    );
    this.sink = { write: (data) => this.put(data) };
  }

  private async put(data: Uint8Array | string): Promise<void> {
    if (this.readerClosed) throw new BrokenPipe();
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data.slice();
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.buffered += bytes.length;
    this.readerWake?.();
    while (this.buffered > PIPE_CAPACITY && !this.readerClosed) {
      await new Promise<void>((r) => this.writerWakes.push(r));
    }
    if (this.readerClosed) throw new BrokenPipe();
  }

  private async take(): Promise<Uint8Array | null> {
    while (this.chunks.length === 0) {
      if (this.writerClosed || this.readerClosed) return null;
      await new Promise<void>((r) => (this.readerWake = r));
      this.readerWake = null;
    }
    const chunk = this.chunks.shift()!;
    this.buffered -= chunk.length;
    for (const w of this.writerWakes.splice(0)) w();
    return chunk;
  }

  /** End of input for the reader once buffered data is drained. */
  closeWriter(): void {
    this.writerClosed = true;
    this.readerWake?.();
  }

  private closeReader(): void {
    this.readerClosed = true;
    this.chunks.length = 0;
    this.buffered = 0;
    for (const w of this.writerWakes.splice(0)) w();
  }
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function readAll(src: Source): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let c = await src.read(); c !== null; c = await src.read()) chunks.push(c);
  return concatBytes(chunks);
}

const decoder = new TextDecoder();
export const decode = (b: Uint8Array): string => decoder.decode(b);

/**
 * Reads one line (bytes up to and including `delim`) and pushes the rest of
 * the chunk back, so the next reader of `src` continues right after it.
 * Returns null at end of input.
 */
export async function readLineShared(src: Source, delim = 0x0a): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  for (;;) {
    const chunk = await src.read();
    if (chunk === null) return parts.length > 0 ? concatBytes(parts) : null;
    const i = chunk.indexOf(delim);
    if (i < 0) {
      parts.push(chunk);
      continue;
    }
    parts.push(chunk.subarray(0, i + 1));
    src.unshift(chunk.subarray(i + 1));
    return concatBytes(parts);
  }
}

/**
 * Iterates lines of a source (without the newline). `last` is true for a final
 * line that had no trailing newline.
 */
export async function* lines(
  src: Source,
  delim = 0x0a,
): AsyncGenerator<{ text: string; newline: boolean }> {
  let rest: Uint8Array | null = null;
  for (let chunk = await src.read(); chunk !== null; chunk = await src.read()) {
    let buf: Uint8Array = rest ? concatBytes([rest, chunk]) : chunk;
    let start = 0;
    for (let i = buf.indexOf(delim, start); i >= 0; i = buf.indexOf(delim, start)) {
      yield { text: decode(buf.subarray(start, i)), newline: true };
      start = i + 1;
    }
    buf = buf.subarray(start);
    rest = buf.length > 0 ? buf.slice() : null;
  }
  if (rest) yield { text: decode(rest), newline: false };
}

/** Collects all lines of a source. */
export async function readLines(
  src: Source,
  delim = 0x0a,
): Promise<{ text: string; newline: boolean }[]> {
  const out: { text: string; newline: boolean }[] = [];
  for await (const l of lines(src, delim)) out.push(l);
  return out;
}
