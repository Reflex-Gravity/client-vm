// SPDX-License-Identifier: Apache-2.0
// Terminal line editing shared by `readline` (terminal mode) and the
// interactive shell: key decoding as Node's emitKeypressEvents does it, an
// editable line with history, and redrawing a prompt + line that may wrap.

/** A key as Node's `keypress` event describes it. */
export interface Key {
  sequence: string;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
}

const key = (sequence: string, name: string | undefined, mods: Partial<Key> = {}): Key => ({
  sequence,
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
});

/** Final characters of CSI/SS3 sequences without a number. */
const LETTER_KEYS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  E: 'clear',
  F: 'end',
  H: 'home',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  Z: 'tab',
};

/** `ESC [ <n> ~` keys. */
const TILDE_KEYS: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12',
};

// CSI (ESC [ params final) or SS3 (ESC O final), with an optional extra ESC for meta.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /^(\x1b+)(?:\[([0-9;]*)([A-Za-z~])|O([0-9]*)([A-Za-z]))/;

function applyModifier(k: Key, modifier: number): Key {
  // xterm modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4 | meta 8).
  const bits = Math.max(modifier - 1, 0);
  return { ...k, shift: (bits & 1) !== 0, meta: (bits & 10) !== 0, ctrl: (bits & 4) !== 0 };
}

/** Splits terminal input into keys (one call per data chunk). */
export function parseKeys(text: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = ESCAPE_SEQUENCE.exec(rest);
    if (m) {
      const [sequence, escapes, params, final, ss3Params, ss3Final] = m;
      const meta = escapes!.length > 1;
      let k: Key;
      if (final === '~') {
        const [num, mod] = (params ?? '').split(';');
        k = key(sequence, TILDE_KEYS[num ?? ''] ?? 'undefined');
        if (mod) k = applyModifier(k, Number(mod));
        if (k.name === 'undefined') k.name = undefined;
      } else {
        const f = final ?? ss3Final ?? '';
        k = key(sequence, LETTER_KEYS[f]);
        if (f === 'Z') k.shift = true;
        const parts = (params ?? ss3Params ?? '').split(';');
        const mod = parts.length > 1 ? Number(parts[1]) : Number(ss3Params || 0);
        if (mod > 1) k = applyModifier(k, mod);
      }
      if (meta) k.meta = true;
      // eslint-disable-next-line no-control-regex
      k.code = sequence.replace(/^\x1b+/, '');
      keys.push(k);
      i += sequence.length;
      continue;
    }
    const cp = rest.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '\x1b') {
      // ESC followed by a key is that key with meta (Alt+x); alone, it is Escape.
      const next = text[i];
      if (next === undefined || next === '\x1b') keys.push(key(ch, 'escape'));
      else {
        const [inner] = parseKeys(next);
        i += next.length;
        keys.push({ ...inner!, sequence: ch + next, meta: true });
      }
      continue;
    }
    keys.push(simpleKey(ch));
  }
  return keys;
}

function simpleKey(ch: string): Key {
  if (ch === '\r') return key(ch, 'return');
  if (ch === '\n') return key(ch, 'enter');
  if (ch === '\t') return key(ch, 'tab');
  if (ch === '\b' || ch === '\x7f') return key(ch, 'backspace');
  if (ch === ' ') return key(ch, 'space');
  const c = ch.charCodeAt(0);
  if (c > 0 && c <= 0x1a) return key(ch, String.fromCharCode(c + 0x60), { ctrl: true });
  if (/^[a-z]$/.test(ch)) return key(ch, ch);
  if (/^[A-Z]$/.test(ch)) return key(ch, ch.toLowerCase(), { shift: true });
  if (/^[0-9]$/.test(ch)) return key(ch, ch);
  return key(ch, undefined);
}

/** Display width of text: code points, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  return Array.from(visible).length;
}

/** What a key did to the line. */
export type EditResult = 'edit' | 'submit' | 'interrupt' | 'eof' | 'complete' | 'clear' | 'ignored';

const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/** An editable line with Emacs-style keys and history (newest first, as Node keeps it). */
export class LineEditor {
  /** The line as code points, so the cursor never splits a character. */
  private chars: string[] = [];
  cursor = 0;
  history: string[];
  readonly historySize: number;
  private historyIndex = -1;
  /** The line being typed before browsing history. */
  private draft: string[] = [];

  constructor(opts: { history?: string[]; historySize?: number } = {}) {
    this.historySize = opts.historySize ?? 1000;
    this.history = (opts.history ?? []).slice(0, this.historySize);
  }

  get line(): string {
    return this.chars.join('');
  }

  set line(text: string) {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
  }

  /** The text before the cursor. */
  get beforeCursor(): string {
    return this.chars.slice(0, this.cursor).join('');
  }

  insert(text: string): void {
    const add = Array.from(text);
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  /** Replaces the `count` characters before the cursor with `text` (completion). */
  replaceBefore(count: number, text: string): void {
    const from = Math.max(this.cursor - count, 0);
    this.chars.splice(from, this.cursor - from);
    this.cursor = from;
    this.insert(text);
  }

  /** Starts a new, empty line (after submit, Ctrl+C). */
  reset(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = [];
  }

  addHistory(line: string): void {
    if (!line.trim() || this.history[0] === line) return;
    this.history.unshift(line);
    if (this.history.length > this.historySize) this.history.length = this.historySize;
  }

  key(k: Key): EditResult {
    const { name } = k;
    if (k.ctrl && !k.meta) {
      switch (name) {
        case 'c':
          return 'interrupt';
        case 'd':
          if (this.chars.length === 0) return 'eof';
          return this.deleteRight();
        case 'a':
          return this.move(-this.cursor);
        case 'e':
          return this.move(this.chars.length - this.cursor);
        case 'b':
          return this.move(-1);
        case 'f':
          return this.move(1);
        case 'h':
          return this.deleteLeft();
        case 'u':
          this.chars.splice(0, this.cursor);
          this.cursor = 0;
          return 'edit';
        case 'k':
          this.chars.length = this.cursor;
          return 'edit';
        case 'w':
          return this.deleteWordLeft();
        case 'l':
          return 'clear';
        case 'p':
          return this.browse(1);
        case 'n':
          return this.browse(-1);
        case 'left':
          return this.wordMove(-1);
        case 'right':
          return this.wordMove(1);
        case 'm':
        case 'j':
          return 'submit';
        case 'i':
          return 'complete';
      }
      return 'ignored';
    }
    if (k.meta) {
      switch (name) {
        case 'b':
        case 'left':
          return this.wordMove(-1);
        case 'f':
        case 'right':
          return this.wordMove(1);
        case 'backspace':
          return this.deleteWordLeft();
        case 'd':
          return this.deleteWordRight();
      }
      return 'ignored';
    }
    switch (name) {
      case 'return':
      case 'enter':
        return 'submit';
      case 'backspace':
        return this.deleteLeft();
      case 'delete':
        return this.deleteRight();
      case 'left':
        return this.move(-1);
      case 'right':
        return this.move(1);
      case 'home':
        return this.move(-this.cursor);
      case 'end':
        return this.move(this.chars.length - this.cursor);
      case 'up':
        return this.browse(1);
      case 'down':
        return this.browse(-1);
      case 'tab':
        return k.shift ? 'ignored' : 'complete';
    }
    // Printable text (a key, or a paste that arrived as one chunk).
    const text = k.sequence;
    // eslint-disable-next-line no-control-regex
    if (text && !/[\x00-\x1f\x7f]/.test(text)) {
      this.insert(text);
      return 'edit';
    }
    return 'ignored';
  }

  /**
   * Redraws `prompt` + line for a terminal `cols` wide. `cursorRow` is the row
   * the cursor was on, relative to the prompt's first row, after the previous
   * draw (0 for a fresh line). Returns the output and the new cursor row.
   */
  render(prompt: string, cols: number, cursorRow: number): { text: string; cursorRow: number } {
    const width = Math.max(cols, 1);
    let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
    out += `\r\x1b[J${prompt}${this.line}`;
    const promptWidth = displayWidth(prompt);
    const end = promptWidth + this.chars.length;
    const endRow = Math.floor(end / width);
    // At an exact multiple of the width the terminal holds the cursor at the
    // last column; a line break puts it where the next character would go.
    if (end > 0 && end % width === 0) out += '\r\n';
    const at = promptWidth + this.cursor;
    const row = Math.floor(at / width);
    const col = at % width;
    if (endRow > row) out += `\x1b[${endRow - row}A`;
    out += '\r';
    if (col > 0) out += `\x1b[${col}C`;
    return { text: out, cursorRow: row };
  }

  private move(delta: number): EditResult {
    const next = Math.min(Math.max(this.cursor + delta, 0), this.chars.length);
    if (next === this.cursor) return 'ignored';
    this.cursor = next;
    return 'edit';
  }

  private wordMove(dir: -1 | 1): EditResult {
    let i = this.cursor;
    if (dir < 0) {
      while (i > 0 && !isWordChar(this.chars[i - 1]!)) i--;
      while (i > 0 && isWordChar(this.chars[i - 1]!)) i--;
    } else {
      while (i < this.chars.length && !isWordChar(this.chars[i]!)) i++;
      while (i < this.chars.length && isWordChar(this.chars[i]!)) i++;
    }
    return this.move(i - this.cursor);
  }

  private deleteLeft(): EditResult {
    if (this.cursor === 0) return 'ignored';
    this.chars.splice(--this.cursor, 1);
    return 'edit';
  }

  private deleteRight(): EditResult {
    if (this.cursor === this.chars.length) return 'ignored';
    this.chars.splice(this.cursor, 1);
    return 'edit';
  }

  private deleteWordLeft(): EditResult {
    // Like bash's Ctrl+W: back over whitespace, then over non-whitespace.
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.chars[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.chars[i - 1]!)) i--;
    if (i === this.cursor) return 'ignored';
    this.chars.splice(i, this.cursor - i);
    this.cursor = i;
    return 'edit';
  }

  private deleteWordRight(): EditResult {
    let i = this.cursor;
    while (i < this.chars.length && !isWordChar(this.chars[i]!)) i++;
    while (i < this.chars.length && isWordChar(this.chars[i]!)) i++;
    if (i === this.cursor) return 'ignored';
    this.chars.splice(this.cursor, i - this.cursor);
    return 'edit';
  }

  /** Steps through history: 1 is older, -1 newer. */
  private browse(dir: 1 | -1): EditResult {
    const next = this.historyIndex + dir;
    if (next < -1 || next >= this.history.length) return 'ignored';
    if (this.historyIndex === -1) this.draft = [...this.chars];
    this.historyIndex = next;
    this.chars = next === -1 ? [...this.draft] : Array.from(this.history[next]!);
    this.cursor = this.chars.length;
    return 'edit';
  }
}
