// SPDX-License-Identifier: Apache-2.0
// `readline` and `readline/promises`: line splitting over a readable stream,
// prompts and questions, and the ANSI cursor helpers. On a terminal
// (`terminal: true`, the default when output is a TTY) the interface puts
// the input in raw mode and edits the line itself, with history, as Node does.

import { EventEmitter } from './events.ts';
import { LineEditor, displayWidth, parseKeys } from './line-editor.ts';
import type { Key } from './line-editor.ts';

interface Readable {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off?(event: string, fn: (...args: unknown[]) => void): unknown;
  removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
  emit?(event: string, ...args: unknown[]): unknown;
  listenerCount?(event: string): number;
  setEncoding?(enc: string): unknown;
  pause?(): unknown;
  resume?(): unknown;
  setRawMode?(mode: boolean): unknown;
  isTTY?: boolean;
}

interface Writable {
  write(chunk: string, cb?: () => void): unknown;
  isTTY?: boolean;
  columns?: number;
}

type Completer = (
  line: string,
  cb?: (err: unknown, result: [string[], string]) => void,
) => [string[], string] | void;

interface InterfaceOptions {
  input?: Readable;
  output?: Writable;
  prompt?: string;
  crlfDelay?: number;
  terminal?: boolean;
  history?: string[];
  historySize?: number;
  completer?: Completer;
  signal?: AbortSignal;
}

const kKeypressDecoder = Symbol('keypress-decoder');

/** Makes `stream` emit `keypress` (char, key) events from its data, as Node's does. */
export function emitKeypressEvents(stream: Readable & Record<symbol, unknown>): void {
  if (stream[kKeypressDecoder]) return;
  const decoder = new TextDecoder();
  stream[kKeypressDecoder] = decoder;
  const onData = (chunk: unknown) => {
    if ((stream.listenerCount?.('keypress') ?? 0) === 0) {
      stream.removeListener('data', onData);
      stream.on('newListener', onNewListener);
      return;
    }
    const text =
      typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    for (const key of parseKeys(text))
      stream.emit?.('keypress', key.sequence.length === 1 ? key.sequence : undefined, key);
  };
  const onNewListener = (event: unknown) => {
    if (event !== 'keypress') return;
    stream.on('data', onData);
    stream.removeListener('newListener', onNewListener);
  };
  if ((stream.listenerCount?.('keypress') ?? 0) > 0) stream.on('data', onData);
  else stream.on('newListener', onNewListener);
}

const decoder = () => new TextDecoder();

export class Interface extends EventEmitter {
  terminal = false;
  line = '';
  cursor = 0;
  closed = false;
  input: Readable | undefined;
  output: Writable | undefined;
  history: string[] = [];
  #prompt: string;
  #editor: LineEditor | null = null;
  #completer: Completer | undefined;
  /** The cursor's row below the prompt's first row after the last redraw. */
  #cursorRow = 0;
  /** The prompt shown while a question is open. */
  #questionPrompt: string | null = null;
  #onKeypress = (_s: unknown, key: unknown) => this.#ttyWrite(key as Key);
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
    this.#completer = opts.completer;
    this.terminal = opts.terminal ?? this.output?.isTTY === true;
    if (this.terminal && this.input) {
      this.#editor = new LineEditor({
        history: opts.history ?? [],
        historySize: opts.historySize ?? 30,
      });
      this.history = this.#editor.history;
      emitKeypressEvents(this.input as Readable & Record<symbol, unknown>);
      this.input.on('keypress', this.#onKeypress);
      this.input.on('end', this.#onEnd);
      this.input.setRawMode?.(true);
      this.input.resume?.();
    } else if (this.input) {
      this.input.on('data', this.#onData);
      this.input.on('end', this.#onEnd);
      this.input.resume?.();
    }
    opts.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  /** Terminal mode: one key from the input. */
  #ttyWrite(key: Key): void {
    const editor = this.#editor;
    if (!editor || this.closed || !key) return;
    if (this.#paused) this.resume();
    switch (editor.key(key)) {
      case 'submit': {
        const line = editor.line;
        this.output?.write('\r\n');
        editor.addHistory(line);
        editor.reset();
        this.#cursorRow = 0;
        this.#sync();
        this.#line(line);
        return;
      }
      case 'interrupt':
        if (this.listenerCount('SIGINT') > 0) this.emit('SIGINT');
        else this.close();
        return;
      case 'eof':
        this.close();
        return;
      case 'clear':
        this.output?.write('\x1b[H\x1b[2J');
        this.#cursorRow = 0;
        this.#refresh();
        return;
      case 'complete':
        if (this.#completer) this.#complete();
        else {
          editor.insert('\t');
          this.#sync();
          this.#refresh();
        }
        return;
      case 'edit':
        this.#sync();
        this.#refresh();
        return;
      case 'ignored':
        return;
    }
  }

  #complete(): void {
    const editor = this.#editor!;
    const apply = (result: [string[], string] | undefined) => {
      if (!result) return;
      const [hits, sub] = result;
      if (hits.length === 0) return;
      let common = hits[0]!;
      for (const h of hits) while (!h.startsWith(common)) common = common.slice(0, -1);
      if (common.length > sub.length) {
        editor.replaceBefore(Array.from(sub).length, common);
      } else if (hits.length > 1) {
        this.output?.write(`\r\n${hits.join('  ')}\r\n`);
        this.#cursorRow = 0;
      }
      this.#sync();
      this.#refresh();
    };
    const line = editor.beforeCursor;
    if (this.#completer!.length >= 2) {
      this.#completer!(line, (err, result) => {
        if (!err) apply(result);
      });
    } else apply(this.#completer!(line) as [string[], string]);
  }

  #sync(): void {
    if (!this.#editor) return;
    this.line = this.#editor.line;
    this.cursor = this.#editor.cursor;
  }

  /** Redraws the prompt and line. */
  #refresh(): void {
    if (!this.output || !this.#editor) return;
    const prompt = this.#questionPrompt ?? this.#prompt;
    const { text, cursorRow } = this.#editor.render(
      prompt,
      this.output.columns ?? 80,
      this.#cursorRow,
    );
    this.#cursorRow = cursorRow;
    this.output.write(text);
  }

  #push(chunk: unknown): void {
    this.#buffer +=
      typeof chunk === 'string'
        ? chunk
        : this.#decode.decode(chunk as Uint8Array, { stream: true });
    for (;;) {
      // A \r\n split across chunks: drop the \n that follows a \r line end.
      if (this.#sawCR && this.#buffer.length > 0) {
        if (this.#buffer.startsWith('\n')) this.#buffer = this.#buffer.slice(1);
        this.#sawCR = false;
      }
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
    this.#questionPrompt = null;
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
    if (this.#editor) {
      this.#cursorRow = 0;
      this.#refresh();
    } else this.output?.write(this.#prompt);
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
    if (this.#editor) {
      this.#questionPrompt = query;
      this.#cursorRow = 0;
      this.#refresh();
    } else this.output?.write(query);
  }

  write(data: string | Uint8Array | undefined, key?: Key): void {
    if (this.closed) throw closedError();
    if (this.#editor) {
      // Keys typed programmatically, as Node's terminal-mode write does.
      if (key) this.#ttyWrite({ ...key, sequence: key.sequence ?? String(data ?? '') });
      else if (data !== undefined) {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        for (const k of parseKeys(text)) this.#ttyWrite(k);
      }
      return;
    }
    if (data !== undefined) this.#push(data);
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
      if (this.#editor) {
        this.input.removeListener('keypress', this.#onKeypress);
        this.input.setRawMode?.(false);
      }
      this.input.pause?.();
    }
    this.emit('close');
  }

  getCursorPos(): { rows: number; cols: number } {
    if (!this.#editor) return { rows: 0, cols: this.cursor };
    const cols = this.output?.columns ?? 80;
    const at = displayWidth(this.#questionPrompt ?? this.#prompt) + this.#editor.cursor;
    return { rows: Math.floor(at / cols), cols: at % cols };
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
    emitKeypressEvents,
    promises,
  };
  return { readline, promises };
}
