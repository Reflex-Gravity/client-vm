// SPDX-License-Identifier: Apache-2.0
// Process output is written by hostile code but drawn by the host page's
// terminal. Plain text and CSI sequences (colors, cursor movement) only change
// what the terminal shows; string sequences can do more: OSC 52 writes the
// clipboard, OSC 8 makes links, DCS/APC reach terminal extensions. Only window
// titles (OSC 0, 1, 2) are kept (docs/security.md).

/** Longest string sequence kept; longer ones are dropped whole. */
const MAX_STRING = 4096;

const ESC = '\x1b';
const BEL = '\x07';
/** C1 controls that start a string sequence: DCS, SOS, OSC, PM, APC. */
const C1_STRING = new Set(['\x90', '\x98', '\x9d', '\x9e', '\x9f']);
/** Final bytes of `ESC <x>` that start one. */
const ESC_STRING: Record<string, string> = {
  P: '\x90',
  X: '\x98',
  ']': '\x9d',
  '^': '\x9e',
  _: '\x9f',
};
const ST = '\x9c';
// eslint-disable-next-line no-control-regex
const SPECIAL = /[\x1b\x90\x98\x9c-\x9f]/;
// eslint-disable-next-line no-control-regex
const TITLE = /^[012];[^\x00-\x1f\x7f-\x9f]*$/;

/**
 * Returns a filter for one output stream that removes string sequences
 * except window titles. Keeps state across chunks, so a sequence split
 * between writes is still recognized.
 */
export function createSanitizer(): (chunk: string) => string {
  let state: 'text' | 'esc' | 'string' | 'string-esc' = 'text';
  /** The C1 form of the string sequence being read. */
  let kind = '';
  let body = '';
  let overflow = false;
  let out = '';

  const start = (k: string) => {
    state = 'string';
    kind = k;
    body = '';
    overflow = false;
  };
  const finish = () => {
    if (kind === '\x9d' && !overflow && TITLE.test(body)) out += `${ESC}]${body}${BEL}`;
    state = 'text';
  };
  const step = (c: string): void => {
    switch (state) {
      case 'text':
        if (c === ESC) state = 'esc';
        else if (C1_STRING.has(c)) start(c);
        else out += c;
        return;
      case 'esc': {
        const k = ESC_STRING[c];
        if (k !== undefined) start(k);
        else {
          out += ESC + c;
          state = 'text';
        }
        return;
      }
      case 'string':
        if (c === BEL || c === ST) finish();
        else if (c === ESC) state = 'string-esc';
        else if (overflow || body.length >= MAX_STRING) {
          overflow = true;
          body = '';
        } else body += c;
        return;
      case 'string-esc':
        if (c === '\\') {
          finish();
          return;
        }
        // Any other ESC sequence cancels the string and is read as usual.
        state = 'esc';
        step(c);
    }
  };

  return (chunk) => {
    if (state === 'text' && !SPECIAL.test(chunk)) return chunk;
    out = '';
    for (const c of chunk) step(c);
    return out;
  };
}
