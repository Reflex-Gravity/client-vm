// SPDX-License-Identifier: Apache-2.0
import type { Process } from '@clientvm/clientvm';
import { describe, expect, it } from 'vitest';
import { attachShell } from './shell.ts';

function fakeProcess() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (e: { code: number; signal?: 'SIGHUP' }) => void;
  const typed: string[] = [];
  const calls: string[] = [];
  const proc = {
    pid: 4,
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (out = c) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    stdin: new WritableStream<Uint8Array>({
      write: (d) => void typed.push(new TextDecoder().decode(d)),
    }),
    exit: new Promise((r) => (finish = r)),
    kill: (s: string) => {
      calls.push(`kill ${s}`);
      out.close();
      finish({ code: 129, signal: 'SIGHUP' });
    },
    resize: (c: number, r: number) => void calls.push(`resize ${c}x${r}`),
  } as unknown as Process;
  return {
    proc,
    typed,
    calls,
    print: (s: string) => out.enqueue(new TextEncoder().encode(s)),
    end: (code: number) => {
      out.close();
      finish({ code });
    },
  };
}

function fakeTerminal() {
  let data: ((d: string) => void) | undefined;
  let resize: ((s: { cols: number; rows: number }) => void) | undefined;
  const term = {
    cols: 100,
    rows: 30,
    screen: '',
    write(d: string) {
      term.screen += d;
    },
    onData: (cb: (d: string) => void) => ((data = cb), { dispose: () => (data = undefined) }),
    onResize: (cb: (s: { cols: number; rows: number }) => void) => (
      (resize = cb),
      { dispose: () => (resize = undefined) }
    ),
    type: (d: string) => data?.(d),
    resizeTo: (cols: number, rows: number) => resize?.({ cols, rows }),
    attached: () => data !== undefined,
  };
  return term;
}

/** Output is drawn once a frame (setTimeout 16 ms outside a browser). */
const frame = () => new Promise((r) => setTimeout(r, 20));

describe('attachShell', () => {
  it('spawns bash -i on a pty sized to the terminal and connects keys, output and resizes', async () => {
    const p = fakeProcess();
    const term = fakeTerminal();
    const spawned: unknown[] = [];
    const session = await attachShell(term, {
      spawn: async (...args: unknown[]) => (spawned.push(args), p.proc),
    } as never);
    expect(spawned).toEqual([
      ['bash', ['-i'], { pty: { cols: 100, rows: 30 }, tag: { source: 'terminal' } }],
    ]);
    term.type('ls\r');
    p.print('a.txt\r\n\x1b]52;c;AAAA\x07\x1b[32mok\x1b[0m');
    term.resizeTo(120, 40);
    await frame();
    expect(p.typed).toEqual(['ls\r']);
    expect(term.screen).toBe('a.txt\r\n\x1b[32mok\x1b[0m');
    expect(p.calls).toEqual(['resize 120x40']);
    expect(session.process).toBe(p.proc);
  });

  it('reports the exit in the terminal and stops listening', async () => {
    const p = fakeProcess();
    const term = fakeTerminal();
    const session = await attachShell(term, { spawn: async () => p.proc } as never, {
      command: 'node',
    });
    p.end(3);
    expect(await session.exit).toEqual({ code: 3 });
    expect(term.screen).toContain('[process exited with code 3]');
    expect(term.attached()).toBe(false);
  });

  it('dispose detaches and hangs up the shell', async () => {
    const p = fakeProcess();
    const term = fakeTerminal();
    const session = await attachShell(term, { spawn: async () => p.proc } as never);
    session.dispose();
    term.type('ignored');
    await session.exit;
    expect(p.calls).toEqual(['kill SIGHUP']);
    expect(p.typed).toEqual([]);
    expect(term.screen).toBe('');
  });
});
