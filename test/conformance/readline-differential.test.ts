// SPDX-License-Identifier: Apache-2.0
// node-compat readline vs node:readline on the same chunked input.
import * as nodeReadline from 'node:readline';
import { PassThrough } from 'node:stream';
import { createReadline } from '@clientvm/node-compat';
import { describe, expect, it } from 'vitest';

const ours = createReadline().readline as unknown as typeof nodeReadline;

async function lines(rl: typeof nodeReadline, chunks: string[]): Promise<string[]> {
  const input = new PassThrough();
  const iface = rl.createInterface({ input, crlfDelay: Infinity });
  const out: string[] = [];
  iface.on('line', (l) => out.push(l));
  const closed = new Promise((r) => iface.on('close', r));
  for (const c of chunks) input.write(Buffer.from(c));
  input.end();
  await closed;
  return out;
}

const CASES: string[][] = [
  ['a\nb\nc'],
  ['a\r\nb\r\n'],
  ['one', ' two\nthr', 'ee\n'],
  ['x\r', '\ny\n'],
  ['\n\n\n'],
  ['café\n', 'ü\n'],
  [''],
  ['last line without newline'],
];

describe('readline matches Node', () => {
  for (const chunks of CASES) {
    it(JSON.stringify(chunks), async () => {
      expect(await lines(ours, chunks)).toEqual(await lines(nodeReadline, chunks));
    });
  }

  it('async iteration and question()', async () => {
    const run = async (rl: typeof nodeReadline) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let written = '';
      output.on('data', (d) => (written += d));
      const iface = rl.createInterface({ input, output, terminal: false });
      const answer = new Promise<string>((r) => iface.question('name? ', r));
      input.write('ada\nl1\nl2\n');
      input.end();
      const got = [await answer];
      for await (const l of iface) got.push(l);
      return { got, written };
    };
    expect(await run(ours)).toEqual(await run(nodeReadline));
  });
});

/** A PassThrough that says it is a terminal, as process.stdin/stdout on a pty. */
function ttyPair() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.resume();
  return { input, output };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('readline on a terminal matches Node', () => {
  it('emitKeypressEvents decodes the same keys', async () => {
    const run = async (rl: typeof nodeReadline) => {
      const { input } = ttyPair();
      rl.emitKeypressEvents(input);
      const keys: unknown[] = [];
      input.on('keypress', (s, k: Record<string, unknown>) =>
        keys.push([s, k['name'], k['ctrl'], k['meta'], k['shift'], k['sequence']]),
      );
      for (const chunk of ['ab', 'C 1\r', '\x1b[A\x1b[1;5D\x1b[3~', '\x03\x7f\t', 'é'])
        input.write(Buffer.from(chunk));
      await tick();
      return keys;
    };
    expect(await run(ours)).toEqual(await run(nodeReadline));
  });

  it('edits lines with keys and history, sets raw mode, and restores it on close', async () => {
    const run = async (rl: typeof nodeReadline) => {
      const { input, output } = ttyPair();
      const iface = rl.createInterface({ input, output, prompt: '> ' });
      const rawWhileOpen = input.isRaw;
      const lines: string[] = [];
      iface.on('line', (l) => lines.push(l));
      iface.prompt();
      for (const chunk of [
        'abc\x7fd\r',
        'xy\x1b[D\x1b[Dz\r',
        '\x1b[A\x1b[A\r',
        'one two\x17three\r',
        'kill\x15ok\r',
      ])
        input.write(Buffer.from(chunk));
      await tick();
      const history = [...((iface as unknown as { history: string[] }).history ?? [])];
      iface.close();
      return { lines, rawWhileOpen, rawAfter: input.isRaw, history };
    };
    expect(await run(ours)).toEqual(await run(nodeReadline));
  });

  it('Ctrl+C emits SIGINT when listened to; Ctrl+D on an empty line closes', async () => {
    const run = async (rl: typeof nodeReadline) => {
      const { input, output } = ttyPair();
      const iface = rl.createInterface({ input, output });
      const events: string[] = [];
      iface.on('SIGINT', () => events.push('SIGINT'));
      iface.on('close', () => events.push('close'));
      input.write(Buffer.from('partial\x03'));
      await tick();
      input.write(Buffer.from('\x15\x04'));
      await tick();
      return events;
    };
    expect(await run(ours)).toEqual(await run(nodeReadline));
  });
});
