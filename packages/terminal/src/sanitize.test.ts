// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { displayCommand, stripAnsi } from './command.ts';
import { createSanitizer } from './sanitize.ts';

const clean = (...chunks: string[]) => {
  const s = createSanitizer();
  return chunks.map(s).join('');
};

describe('createSanitizer', () => {
  it('passes text, colors and cursor movement through', () => {
    const text = 'plain\n\x1b[1;32mgreen\x1b[0m \x1b[2K\rprogress \x1b7\x1b8 \x9b31mC1 red';
    expect(clean(text)).toBe(text);
  });

  it('drops clipboard writes, hyperlinks and device control strings', () => {
    expect(clean('a\x1b]52;c;ZXZpbA==\x07b')).toBe('ab');
    expect(clean('\x1b]8;;https://evil.example/\x1b\\click\x1b]8;;\x1b\\')).toBe('click');
    expect(clean('x\x1bP+q544e\x1b\\y\x1b_apc\x9cz\x9d52;c;AA\x07')).toBe('xyz');
  });

  it('keeps window titles, written with BEL', () => {
    expect(clean('\x1b]0;vite dev\x1b\\after')).toBe('\x1b]0;vite dev\x07after');
    expect(clean('\x1b]2;bad\x01title\x07')).toBe('');
  });

  it('recognizes sequences split across chunks', () => {
    expect(clean('a\x1b', ']52;c;', 'AAAA\x1b', '\\b')).toBe('ab');
    expect(clean('\x1b', '[31mred')).toBe('\x1b[31mred');
  });

  it('an ESC inside a string sequence cancels it', () => {
    expect(clean('\x1b]8;;http://x\x1b[1mbold')).toBe('\x1b[1mbold');
  });

  it('drops overlong string sequences whole, even titles', () => {
    expect(clean(`\x1b]0;${'t'.repeat(5000)}\x07ok`)).toBe('ok');
  });
});

describe('displayCommand', () => {
  it('shows the line for sh -c, otherwise a quoted argv', () => {
    expect(displayCommand(['sh', '-c', 'npm i && npm run dev'])).toBe('npm i && npm run dev');
    expect(displayCommand(['node', 'server.js', '--port=3000'])).toBe('node server.js --port=3000');
    expect(displayCommand(['echo', "it's here", ''])).toBe(`echo 'it'\\''s here' ''`);
  });
});

describe('stripAnsi', () => {
  it('removes CSI, OSC and two-byte sequences', () => {
    expect(
      stripAnsi('\x1b[1;31merr\x1b[0m \x1b]0;t\x07ok\x1b(B \x1b]8;;u\x1b\\l\x1b]8;;\x1b\\'),
    ).toBe('err ok l');
  });
});
