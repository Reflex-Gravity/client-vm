// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Pty } from './pty.ts';

function setup(cols = 80, rows = 24) {
  const screen: string[] = [];
  const delivered: string[] = [];
  const signals: string[] = [];
  const pty = new Pty(
    { cols, rows },
    {
      output: (d) => screen.push(new TextDecoder().decode(d)),
      deliver: (d) => delivered.push(new TextDecoder().decode(d)),
      signal: (s) => signals.push(s),
    },
  );
  const type = (s: string) => pty.input(new TextEncoder().encode(s));
  return { pty, type, screen, delivered, signals, shown: () => screen.join('') };
}

describe('Pty cooked mode', () => {
  it('echoes, edits the line, and delivers it on Enter', () => {
    const t = setup();
    t.type('helo');
    t.type('\x7f');
    t.type('lo wor');
    t.type('\x17');
    t.type('world\r');
    expect(t.delivered).toEqual(['hello world\n']);
    expect(t.shown()).toBe('helo\b \blo wor\b \b\b \b\b \bworld\r\n');
  });

  it('kills the line, echoes control characters as carets, erases them whole', () => {
    const t = setup();
    t.type('abc\x15x\x1b\x7f\n');
    expect(t.delivered).toEqual(['x\n']);
    expect(t.shown()).toBe('abc\b \b\b \b\b \bx^[\b \b\b \b\r\n');
  });

  it('Ctrl+C and Ctrl+\\ drop the line and signal the foreground', () => {
    const t = setup();
    t.type('sleep 1\x03');
    t.type('x\x1c');
    expect(t.signals).toEqual(['SIGINT', 'SIGQUIT']);
    expect(t.delivered).toEqual([]);
    expect(t.shown()).toBe('sleep 1^C\r\nx^\\\r\n');
  });

  it('Ctrl+D is end-of-file on an empty line, and sends a partial line as is', () => {
    const t = setup();
    t.type('\x04');
    t.type('abc\x04');
    expect(t.delivered).toEqual(['', 'abc']);
  });

  it('decodes UTF-8 split across writes and erases whole characters', () => {
    const t = setup();
    const e = new TextEncoder().encode('é');
    t.pty.input(e.slice(0, 1));
    t.pty.input(e.slice(1));
    t.type('ü\x7f\r');
    expect(t.delivered).toEqual(['é\n']);
  });
});

describe('Pty raw mode', () => {
  it('passes bytes through without echo or signals', () => {
    const t = setup();
    t.pty.setRaw(true);
    t.type('a\x03\r\x1b[A');
    expect(t.delivered).toEqual(['a\x03\r\x1b[A']);
    expect(t.signals).toEqual([]);
    expect(t.screen).toEqual([]);
  });

  it('leaving raw mode starts a fresh line', () => {
    const t = setup();
    t.type('half');
    t.pty.setRaw(true);
    t.pty.setRaw(false);
    t.type('new\r');
    expect(t.delivered).toEqual(['new\n']);
  });
});

describe('Pty output and size', () => {
  it('turns \\n into \\r\\n', () => {
    const t = setup();
    t.pty.write(new TextEncoder().encode('a\nb\r\nc'));
    t.pty.write(new TextEncoder().encode('plain'));
    expect(t.screen).toEqual(['a\r\nb\r\r\nc', 'plain']);
  });

  it('reports whether a resize changed the size', () => {
    const t = setup();
    expect(t.pty.resize({ cols: 80, rows: 24 })).toBe(false);
    expect(t.pty.resize({ cols: 120, rows: 40 })).toBe(true);
    expect(t.pty.size).toEqual({ cols: 120, rows: 40 });
  });
});
