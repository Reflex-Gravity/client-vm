// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createPortLinker, createTerminalWriter } from './output.ts';

const frame = () => new Promise((r) => setTimeout(r, 20));

function ports(open: Record<number, string>) {
  return {
    onPortOpen: (cb: (port: number, url: string) => void) => {
      for (const [p, u] of Object.entries(open)) cb(Number(p), u);
      return { dispose() {} };
    },
    onPortClose: () => ({ dispose() {} }),
  };
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe('port links', () => {
  const linker = createPortLinker(ports({ 5173: 'https://abc-p5173.sandbox.dev/' }));

  it('links local URLs of open ports to their preview, keeping the text', () => {
    expect(linker.linkify('Local: http://localhost:5173/app?x=1 ok')).toBe(
      'Local: \x1b]8;;https://abc-p5173.sandbox.dev/app?x=1\x1b\\http://localhost:5173/app?x=1\x1b]8;;\x1b\\ ok',
    );
  });

  it("matches Vite's coloured banner", () => {
    const url = '\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/';
    expect(linker.linkify(`${url}\x1b[39m`)).toBe(
      `\x1b[36m\x1b]8;;https://abc-p5173.sandbox.dev/\x1b\\${url.slice(5)}\x1b]8;;\x1b\\\x1b[39m`,
    );
  });

  it('leaves other ports and hosts alone', () => {
    for (const s of ['http://localhost:3000/', 'https://example.com:5173/', 'localhost:5173'])
      expect(linker.linkify(s)).toBe(s);
  });
});

describe('createTerminalWriter', () => {
  it('coalesces writes into one per frame', async () => {
    const writes: string[] = [];
    const w = createTerminalWriter({ write: (d) => void writes.push(d) }, {});
    w.write('a');
    w.write('b');
    expect(writes).toEqual([]);
    await frame();
    expect(writes).toEqual(['ab']);
  });

  it('skips the oldest whole lines of a flood, with a notice', () => {
    const writes: string[] = [];
    const w = createTerminalWriter(
      { write: (d) => void writes.push(d) },
      {},
      { throttle: { maxBacklog: 100, maxPerFrame: 1000 } },
    );
    for (let i = 0; i < 50; i++) w.write(`line ${String(i).padStart(2, '0')}\n`);
    w.flush();
    const text = writes.join('');
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^\x1b\[0m\r\n\x1b\[2m\[clientvm: \d+ characters of output skipped\]/);
    expect(text).toContain('line 49\n');
    expect(text).not.toContain('line 00');
    // What survives starts at a line.
    expect(text.split('\r\n')[2]).toMatch(/^line \d\d$/m);
  });

  it('writes straight through without a throttle', () => {
    const writes: string[] = [];
    const w = createTerminalWriter({ write: (d) => void writes.push(d) }, {}, { throttle: false });
    w.write('now');
    expect(writes).toEqual(['now']);
  });

  it('keeps scrollback in storage and writes it back on the next attach', () => {
    const storage = memoryStorage();
    const first: string[] = [];
    const a = createTerminalWriter(
      { write: (d) => void first.push(d) },
      {},
      { throttle: false, persist: { key: 'k', storage, maxChars: 10 } },
    );
    a.write('0123456789\nabc\n');
    a.dispose();
    expect(storage.m.get('k')).toBe('abc\n');
    const second: string[] = [];
    createTerminalWriter(
      { write: (d) => void second.push(d) },
      {},
      { throttle: false, persist: { key: 'k', storage } },
    );
    expect(second.join('')).toBe('abc\n\x1b[2m[restored from before the page reloaded]\x1b[0m\r\n');
  });
});
