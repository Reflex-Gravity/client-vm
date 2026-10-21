// SPDX-License-Identifier: Apache-2.0
// `readline` and `readline/promises`: line splitting over a readable stream,
// prompts and questions, and the ANSI cursor helpers. ClientVM stdio is never
// a TTY, so there is no line editing or history (terminal: false behavior).

import { EventEmitter } from './events.ts';

interface Readable {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off?(event: string, fn: (...args: unknown[]) => void): unknown;
  removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
  setEncoding?(enc: string): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

interface Writable {
  write(chunk: string, cb?: () => void): unknown;
}

interface InterfaceOptions {
  input?: Readable;
  output?: Writable;
  prompt?: string;
  crlfDelay?: number;
  terminal?: boolean;
  historySize?: number;
  signal?: AbortSignal;
}

const decoder = () => new TextDecoder();

export class Interface extends EventEmitter {
  terminal = false;
  line = '';
  cursor = 0;
  closed = false;
  input: Readable | undefined;
  output: Writable | undefined;
  #prompt: string;
  #buffer = '';
  #decode = decoder();
  #questions: ((answer: string) => void)[] = [];
  #paused = false;
  #sawCR = false;
  #onData = (chunk: unknown) => this.#push(chunk);
  #onEnd = () => {
    const rest = this.#buffer + this.#decode.decode();
    this.#buffer = '';
    if (rest.length > 0) this.#line(rest);
    this.close();
  };

  constructor(input?: Readable | InterfaceOptions, output?: Writable, _completer?: unknown) {
    super();
    const opts: InterfaceOptions =
      input && typeof (input as Readable).on === 'function'
        ? { input: input as Readable, ...(output ? { output } : {}) }
        : ((input as InterfaceOptions | undefined) ?? {});
    this.input = opts.input;
    this.output = opts.output;
    this.#prompt = opts.prompt ?? '> ';
    if (this.input) {
      this.input.on('data', this.#onData);
      this.input.on('end', this.#onEnd);
      this.input.resume?.();
    }
    opts.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  #push(chunk: unknown): void {
    this.#buffer +=
      typeof chunk === 'string'
        ? chunk
        : this.#decode.decode(chunk as Uint8Array, { stream: true });
    for (;;) {
      // A \r\n split across chunks: drop the \n that follows a \r line end.
      if (this.#sawCR && this.#buffer.startsWith('\n')) this.#buffer = this.#buffer.slice(1);
      this.#sawCR = false;
      const m = /\r\n|\n|\r/.exec(this.#buffer);
      if (!m) break;
      const line = this.#buffer.slice(0, m.index);
      this.#buffer = this.#buffer.slice(m.index + m[0].length);
      if (m[0] === '\r' && this.#buffer.length === 0) this.#sawCR = true;
      this.#line(line);
      if (this.closed) break;
    }
  }

  #line(line: string): void {
    const q = this.#questions.shift();
    if (q) q(line);
    else this.emit('line', line);
  }

  getPrompt(): string {
    return this.#prompt;
  }

  setPrompt(prompt: string): void {
    this.#prompt = prompt;
  }

  prompt(_preserveCursor?: boolean): void {
    if (this.closed) throw closedError();
    if (this.#paused) this.resume();
    this.output?.write(this.#prompt);
  }

  question(query: string, options?: unknown, cb?: (answer: string) => void): void {
    const callback = (typeof options === 'function' ? options : cb) as
      ((answer: string) => void) | undefined;
    if (this.closed) throw closedError();
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    if (signal?.aborted) return;
    if (!callback) return;
    this.#questions.push(callback);
    if (this.#paused) this.resume();
    this.output?.write(query);
  }

  write(data: string | Uint8Array): void {
    if (this.closed) throw closedError();
    this.#push(data);
  }

  pause(): this {
    if (this.#paused) return this;
    this.input?.pause?.();
    this.#paused = true;
    this.emit('pause');
    return this;
  }

  resume(): this {
    if (!this.#paused) return this;
    this.input?.resume?.();
    this.#paused = false;
    this.emit('resume');
    return this;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.input) {
      this.input.removeListener('data', this.#onData);
      this.input.removeListener('end', this.#onEnd);
      this.input.pause?.();
    }
    this.emit('close');
  }

  getCursorPos(): { rows: number; cols: number } {
    return { rows: 0, cols: this.cursor };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let done = this.closed;
    const onLine = (l: unknown) => {
      queue.push(l as string);
      wake?.();
    };
    const onClose = () => {
      done = true;
      wake?.();
    };
    this.on('line', onLine);
    this.on('close', onClose);
    const cleanup = () => {
      this.off('line', onLine);
      this.off('close', onClose);
    };
    const it: AsyncIterableIterator<string> = {
      next: async () => {
        while (queue.length === 0 && !done) await new Promise<void>((r) => (wake = r));
        wake = null;
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        cleanup();
        return { value: undefined, done: true };
      },
      return: async () => {
        cleanup();
        this.close();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]: () => it,
    };
    return it;
  }
}

function closedError(): Error {
  const err = new Error('readline was closed');
  (err as { code?: string }).code = 'ERR_USE_AFTER_CLOSE';
  return err;
}

type Cb = (() => void) | undefined;

function writeAnsi(stream: Writable | undefined, data: string, cb: Cb): boolean {
  if (!stream) {
    if (cb) queueMicrotask(cb);
    return true;
  }
  stream.write(data, cb);
  return true;
}

const ESC = '\x1b[';

function cursorTo(stream: Writable, x: number, y?: number | Cb, cb?: Cb): boolean {
  const callback = typeof y === 'function' ? y : cb;
  const row = typeof y === 'number' ? y : undefined;
  if (Number.isNaN(x)) return writeAnsi(stream, '', callback);
  return writeAnsi(
    stream,
    row === undefined ? `${ESC}${x + 1}G` : `${ESC}${row + 1};${x + 1}H`,
    callback,
  );
}

function moveCursor(stream: Writable, dx: number, dy: number, cb?: Cb): boolean {
  let data = '';
  if (dx < 0) data += `${ESC}${-dx}D`;
  else if (dx > 0) data += `${ESC}${dx}C`;
  if (dy < 0) data += `${ESC}${-dy}A`;
  else if (dy > 0) data += `${ESC}${dy}B`;
  return writeAnsi(stream, data, cb);
}

function clearLine(stream: Writable, dir: number, cb?: Cb): boolean {
  return writeAnsi(stream, dir < 0 ? `${ESC}1K` : dir > 0 ? `${ESC}0K` : `${ESC}2K`, cb);
}

function clearScreenDown(stream: Writable, cb?: Cb): boolean {
  return writeAnsi(stream, `${ESC}0J`, cb);
}

/** `readline/promises` Interface: question() returns a promise. */
class PromisesInterface extends Interface {
  override question(query: string, options?: { signal?: AbortSignal }): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      super.question(query, resolve);
    });
  }
}

class Readline {
  #stream: Writable;
  #todo: string[] = [];
  constructor(stream: Writable) {
    this.#stream = stream;
  }
  clearLine(dir: number) {
    this.#todo.push(dir < 0 ? `${ESC}1K` : dir > 0 ? `${ESC}0K` : `${ESC}2K`);
    return this;
  }
  clearScreenDown() {
    this.#todo.push(`${ESC}0J`);
    return this;
  }
  cursorTo(x: number, y?: number) {
    this.#todo.push(y === undefined ? `${ESC}${x + 1}G` : `${ESC}${y + 1};${x + 1}H`);
    return this;
  }
  moveCursor(dx: number, dy: number) {
    if (dx) this.#todo.push(`${ESC}${Math.abs(dx)}${dx < 0 ? 'D' : 'C'}`);
    if (dy) this.#todo.push(`${ESC}${Math.abs(dy)}${dy < 0 ? 'A' : 'B'}`);
    return this;
  }
  commit() {
    const data = this.#todo.join('');
    this.#todo = [];
    return new Promise<void>((r) => this.#stream.write(data, r));
  }
  rollback() {
    this.#todo = [];
    return this;
  }
}

export function createReadline(): { readline: object; promises: object } {
  const promises = {
    Interface: PromisesInterface,
    Readline,
    createInterface: (input?: Readable | InterfaceOptions, output?: Writable) =>
      new PromisesInterface(input, output),
  };
  const readline = {
    Interface,
    createInterface: (input?: Readable | InterfaceOptions, output?: Writable) =>
      new Interface(input, output),
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    emitKeypressEvents: () => {},
    promises,
  };
  return { readline, promises };
}
