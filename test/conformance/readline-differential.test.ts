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
