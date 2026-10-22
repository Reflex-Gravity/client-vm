// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LineEditor, displayWidth, parseKeys } from './line-editor.ts';

const names = (text: string) =>
  parseKeys(text).map(
    (k) =>
      `${k.ctrl ? 'C-' : ''}${k.meta ? 'M-' : ''}${k.shift ? 'S-' : ''}${k.name ?? JSON.stringify(k.sequence)}`,
  );

describe('parseKeys', () => {
  it('decodes printable keys, controls and named keys', () => {
    expect(names('aB1 é\r\n\t\x7f\x03\x1b')).toEqual([
      'a',
      'S-b',
      '1',
      'space',
      '"é"',
      'return',
      'enter',
      'tab',
      'backspace',
      'C-c',
      'escape',
    ]);
  });

  it('decodes CSI and SS3 sequences with modifiers', () => {
    expect(names('\x1b[A\x1bOB\x1b[3~\x1b[1;5C\x1b[1;2D\x1b[5~\x1b[Z\x1b[15~')).toEqual([
      'up',
      'down',
      'delete',
      'C-right',
      'S-left',
      'pageup',
      'S-tab',
      'f5',
    ]);
    expect(parseKeys('\x1b[A')[0]).toMatchObject({ sequence: '\x1b[A', code: '[A' });
  });

  it('treats ESC + key as meta', () => {
    expect(names('\x1bb\x1b\x7f')).toEqual(['M-b', 'M-backspace']);
  });
});

describe('LineEditor', () => {
  const type = (ed: LineEditor, text: string) => parseKeys(text).map((k) => ed.key(k));

  it('inserts, moves and deletes by character and word', () => {
    const ed = new LineEditor();
    type(ed, 'hello world');
    type(ed, '\x1b[D\x1b[D\x7f');
    expect(ed.line).toBe('hello wold');
    type(ed, '\x01X\x05!');
    expect(ed.line).toBe('Xhello wold!');
    type(ed, '\x17');
    expect(ed.line).toBe('Xhello ');
    type(ed, '\x02\x02\x0b');
    expect(ed.line).toBe('Xhell');
    type(ed, '\x15');
    expect([ed.line, ed.cursor]).toEqual(['', 0]);
  });

  it('reports submit, interrupt, eof only on an empty line, completion and clear', () => {
    const ed = new LineEditor();
    expect(type(ed, '\x04')).toEqual(['eof']);
    expect(type(ed, 'a\x04\r\x03\t\x0c')).toEqual([
      'edit',
      'ignored',
      'submit',
      'interrupt',
      'complete',
      'clear',
    ]);
  });

  it('browses history and returns to the draft', () => {
    const ed = new LineEditor({ history: ['two', 'one'] });
    ed.addHistory('two');
    ed.addHistory('  ');
    type(ed, 'dra');
    type(ed, '\x1b[A');
    expect(ed.line).toBe('two');
    type(ed, '\x1b[A\x1b[A');
    expect(ed.line).toBe('one');
    type(ed, '\x1b[B\x1b[B');
    expect(ed.line).toBe('dra');
  });

  it('renders a wrapped line and puts the cursor back where it belongs', () => {
    const ed = new LineEditor();
    ed.line = 'abcdefgh';
    ed.cursor = 2;
    // Prompt "$ " (2 wide) + 8 chars in 5 columns: rows "$ abc", "defgh"; then wrap.
    const r = ed.render('\x1b[1m$\x1b[0m ', 5, 0);
    expect(r.text).toBe('\r\x1b[J\x1b[1m$\x1b[0m abcdefgh\r\n\x1b[2A\r\x1b[4C');
    expect(r.cursorRow).toBe(0);
    ed.cursor = 8;
    const r2 = ed.render('$ ', 5, r.cursorRow);
    expect(r2).toEqual({ text: '\r\x1b[J$ abcdefgh\r\n\r', cursorRow: 2 });
    expect(ed.render('$ ', 5, 2).text.startsWith('\x1b[2A\r')).toBe(true);
  });

  it('measures display width without escape sequences', () => {
    expect(displayWidth('\x1b[1;32muser\x1b[0m:\x1b]0;title\x07~$ ')).toBe(8);
  });
});
